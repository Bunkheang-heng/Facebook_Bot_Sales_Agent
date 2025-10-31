import dotenv from 'dotenv';
dotenv.config();

import express, { type Request, type Response } from 'express';
import path from 'path';
import { sendSenderAction, sendTextMessage, sendProductCarousel } from './social/facebook';
import * as telegram from './social/telegram';
import { handleConversation } from './core/conversation';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './core/config';
import { logger } from './core/logger';
import { RateLimiter } from './security/rate-limiter';
import { verifyWebhookSignature, verifyWebhookChallenge, extractMessagingEvents } from './security/webhook';
import { clampText } from './utils/text';
import { ReplayCache } from './security/replay-cache';
import { MAX_MESSAGE_CHARS, RATE_LIMIT_MAX_EVENTS, RATE_LIMIT_WINDOW_MS, GLOBAL_RATE_LIMIT_MAX, REPLAY_TTL_MS, MAX_EVENT_AGE_MS } from './security/constants';
import { EventBuffer } from './social/event-buffer';

const app = express();

// Security and performance middleware
app.use(helmet());
app.use(compression());

// Serve static assets from the public directory
const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Capture raw body for signature verification with bounded size
app.use(express.json({
  limit: '200kb',
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const PAGE_ACCESS_TOKEN = env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = env.VERIFY_TOKEN;
const APP_SECRET = env.APP_SECRET;
const PORT = env.PORT;
// centralized in security/constants.ts

// Initialize rate limiter
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);
const globalLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, GLOBAL_RATE_LIMIT_MAX);
const replayCache = new ReplayCache(REPLAY_TTL_MS);
// Event buffer to merge related text + image events
const eventBuffer = new EventBuffer(2000); // Wait 2s to collect related events

if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !APP_SECRET) {
  // Fail fast so misconfiguration is caught immediately
  throw new Error('Missing required env vars: PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APP_SECRET');
}

// Webhook verification endpoint (required by Meta)
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  const verificationResult = verifyWebhookChallenge(mode, token, challenge, VERIFY_TOKEN!);
  
  if (verificationResult) {
    res.status(200).send(verificationResult);
  } else {
    res.sendStatus(403);
  }
});

// Event receiver
app.post('/webhook', (req: Request & { rawBody?: Buffer }, res: Response) => {
  const signatureHeader = req.header('x-hub-signature-256');
  
  if (!verifyWebhookSignature(req.rawBody ?? Buffer.from(''), signatureHeader, APP_SECRET!)) {
    return res.sendStatus(401);
  }

  const body = req.body as { 
    object: string; entry: 
    { time: number; messaging: 
      { sender: 
        { id: string }; message: 
        { text: string; mid: string; attachments: 
          { type: string; payload: 
            { url: string } }[] } }[] }[] };

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  const events = extractMessagingEvents(body);

  // Basic global limiter
  if (!globalLimiter.allowEvent('global')) {
    logger.warn('Global rate limit exceeded, dropping batch');
    return res.sendStatus(429);
  }

  // Process each messaging event
  for (const event of events) {
    const { senderId, messageText, mid, imageUrl, hasImage } = event;

    // Replay protection by message ID
    if (mid && replayCache.seen(mid)) {
      logger.debug({ mid }, 'Replay detected: duplicate message id');
      continue;
    }

    // Timestamp-based replay protection if entry time available
    const entryTime = (body.entry && body.entry[0] && body.entry[0].time) ? Number(body.entry[0].time) : undefined;
    if (entryTime && (Date.now() - entryTime) > MAX_EVENT_AGE_MS) {
      logger.warn({ senderId }, 'Stale event rejected due to age check');
      continue;
    }

    // Apply rate limiting
    if (!rateLimiter.allowEvent(senderId)) {
      logger.warn({ senderId }, 'Rate limit exceeded, skipping event');
      continue;
    }

    const clipped = clampText(messageText, MAX_MESSAGE_CHARS);
    
    // Buffer events to merge text + image from same user
    eventBuffer.addEvent(senderId, clipped, imageUrl, mid, (mergedEvent) => {
      // Send typing indicator (non-blocking)
      sendSenderAction(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, 'typing_on')
        .catch((err) => logger.debug({ err }, 'Failed to send typing indicator'));

      // Handle conversation with merged text + image
      const conversationOpts = {
        mid: mergedEvent.mid,
        ...(mergedEvent.imageUrl ? { imageUrl: mergedEvent.imageUrl } : {})
      };
      
      handleConversation(mergedEvent.senderId, mergedEvent.messageText, conversationOpts)
        .then(async (resp) => {
          try {
            if (resp.products && resp.products.length > 0) {
              await sendProductCarousel(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, resp.products);
            }
          } catch (err) {
            logger.error({ err, senderId: mergedEvent.senderId }, 'Failed to send product carousel');
          }
          return sendTextMessage(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, resp.text);
        })
        .catch((err) => {
          logger.error({ err, senderId: mergedEvent.senderId }, 'Failed to generate/send AI reply');
        });
    });
  }

  res.sendStatus(200);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/healthz', async (_req, res) => {
  try {
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ============================================================================
// TELEGRAM WEBHOOK
// ============================================================================

/**
 * Telegram webhook endpoint
 * Handles incoming messages from Telegram
 */
app.post('/telegram/webhook', async (req: Request, res: Response) => {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;

  // Check if Telegram is configured
  if (!TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram bot token not configured');
    return res.sendStatus(404);
  }

  // Validate secret token if configured
  const providedToken = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (TELEGRAM_SECRET_TOKEN && providedToken !== TELEGRAM_SECRET_TOKEN) {
    logger.warn('Invalid Telegram secret token');
    return res.sendStatus(401);
  }

  try {
    const update: telegram.TelegramUpdate = req.body;

    // Extract message data
    const messageData = telegram.extractTelegramMessage(update);
    
    if (!messageData) {
      logger.debug('No message data in Telegram update');
      return res.sendStatus(200);
    }

    const { chatId, userId, messageText, messageId, photo, hasPhoto } = messageData;

    // Log incoming message
    logger.info(
      { 
        chatId, 
        userId, 
        hasPhoto, 
        textLength: messageText.length 
      },
      '📱 Telegram: Incoming message'
    );

    // Check rate limiting
    if (!rateLimiter.allowEvent(String(userId))) {
      logger.warn({ userId }, 'Telegram: Rate limit exceeded');
      await telegram.sendTextMessage(
        TELEGRAM_BOT_TOKEN,
        chatId,
        'Please slow down! You\'re sending messages too quickly. ⏱️'
      );
      return res.sendStatus(200);
    }

    // Process message asynchronously (don't block response)
    (async () => {
      try {
        // Send typing indicator
        await telegram.sendChatAction(TELEGRAM_BOT_TOKEN, chatId, 'typing');

        // Get photo URL if available
        let imageUrl: string | undefined;
        if (photo) {
          const fileUrl = await telegram.getFileUrl(TELEGRAM_BOT_TOKEN, photo);
          imageUrl = fileUrl ?? undefined;
        }

        // Handle conversation
        const conversationOpts = {
          mid: messageId ? String(messageId) : undefined,
          imageUrl
        };

        const response = await handleConversation(
          String(userId),
          messageText,
          conversationOpts
        );

        // Send response
        await telegram.sendMessage(
          TELEGRAM_BOT_TOKEN,
          chatId,
          response.text,
          response.products
        );

        logger.info({ chatId, userId }, '✅ Telegram: Message processed successfully');

      } catch (error: any) {
        logger.error(
          { 
            error: error.message, 
            chatId, 
            userId 
          },
          '❌ Telegram: Failed to process message'
        );

        // Send error message to user
        await telegram.sendTextMessage(
          TELEGRAM_BOT_TOKEN,
          chatId,
          'Sorry, there was an error processing your message. Please try again. 🔧'
        ).catch(() => {});
      }
    })();

    // Respond immediately to Telegram
    res.sendStatus(200);

  } catch (error: any) {
    logger.error(
      { error: error.message },
      '❌ Telegram: Webhook error'
    );
    res.sendStatus(500);
  }
});

/**
 * Handle Telegram callback queries (button presses)
 */
app.post('/telegram/callback', async (req: Request, res: Response) => {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!TELEGRAM_BOT_TOKEN) {
    return res.sendStatus(404);
  }

  try {
    const update: telegram.TelegramUpdate = req.body;
    const callbackQuery = update.callback_query;

    if (callbackQuery) {
      const { id, data, from } = callbackQuery;

      logger.info(
        { 
          userId: from.id, 
          data 
        },
        '🔘 Telegram: Callback query received'
      );

      // Answer the callback to remove loading state
      await telegram.answerCallbackQuery(TELEGRAM_BOT_TOKEN, id, {
        text: 'Processing your request...'
      });

      // Handle different callback data
      if (data?.startsWith('buy_')) {
        const productId = data.replace('buy_', '');
        // TODO: Handle product purchase
        logger.info({ userId: from.id, productId }, 'User wants to buy product');
      } else if (data?.startsWith('info_')) {
        const productId = data.replace('info_', '');
        // TODO: Show more product info
        logger.info({ userId: from.id, productId }, 'User wants more info');
      }
    }

    res.sendStatus(200);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Telegram callback error');
    res.sendStatus(500);
  }
});

// Clean up expired rate limit buckets every minute to prevent memory leak
rateLimiter.startAutoCleanup(60000);

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Server listening on http://localhost:${PORT}`);
});


