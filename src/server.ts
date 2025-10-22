import dotenv from 'dotenv';
dotenv.config();

import express, { type Request, type Response } from 'express';
import { sendSenderAction, sendTextMessage, sendProductCarousel } from './social/facebook';
import { handleConversation } from './conversation';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config';
import { logger } from './logger';
import { RateLimiter } from './utils/rate-limiter';
import { verifyWebhookSignature, verifyWebhookChallenge, extractMessagingEvents } from './utils/webhook';
import { clampText } from './utils/text';

const app = express();

// Security and performance middleware
app.use(helmet());
app.use(compression());

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
const MAX_MESSAGE_CHARS = 800;
const RATE_LIMIT_WINDOW_MS = 30_000; // 30s
const RATE_LIMIT_MAX_EVENTS = 4; // per window per user

// Initialize rate limiter
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);

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

  const body = req.body as any;
  const events = extractMessagingEvents(body);

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  // Process each messaging event
  for (const event of events) {
    const { senderId, messageText, mid, imageUrl, hasImage } = event;

    // Apply rate limiting
    if (!rateLimiter.allowEvent(senderId)) {
      logger.warn({ senderId }, 'Rate limit exceeded, skipping event');
      continue;
    }

    const clipped = clampText(messageText, MAX_MESSAGE_CHARS);
    
    // Send typing indicator (non-blocking)
    sendSenderAction(PAGE_ACCESS_TOKEN!, senderId, 'typing_on')
      .catch((err) => logger.debug({ err }, 'Failed to send typing indicator'));

    // Handle conversation asynchronously (with image if present)
    const conversationOpts = {
      mid,
      ...(hasImage && imageUrl ? { imageUrl } : {})
    };
    
    handleConversation(senderId, clipped, conversationOpts)
      .then(async (resp) => {
        try {
          if (resp.products && resp.products.length > 0) {
            await sendProductCarousel(PAGE_ACCESS_TOKEN!, senderId, resp.products);
          }
        } catch (err) {
          logger.error({ err, senderId }, 'Failed to send product carousel');
        }
        return sendTextMessage(PAGE_ACCESS_TOKEN!, senderId, resp.text);
      })
      .catch((err) => {
        logger.error({ err, senderId }, 'Failed to generate/send AI reply');
      });
  }

  res.sendStatus(200);
});

app.get('/', (_req, res) => {
  res.status(200).send('Messenger bot is running');
});

app.get('/healthz', async (_req, res) => {
  try {
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Clean up expired rate limit buckets every minute to prevent memory leak
rateLimiter.startAutoCleanup(60000);

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Server listening on http://localhost:${PORT}`);
});


