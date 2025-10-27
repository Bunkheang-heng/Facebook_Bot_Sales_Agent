import { logger } from '../src/logger';
import { RateLimiter } from '../src/utils/rate-limiter';
import { ReplayCache } from '../src/utils/replay-cache';
import { EventBuffer } from '../src/utils/event-buffer';
import { verifyWebhookSignature, verifyWebhookChallenge, extractMessagingEvents } from '../src/utils/webhook';
import { clampText } from '../src/utils/text';
import { MAX_MESSAGE_CHARS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS, GLOBAL_RATE_LIMIT_MAX, REPLAY_TTL_MS, MAX_EVENT_AGE_MS } from '../src/security/constants';

// Initialize limiters and replay cache (warm containers preserve state for a while)
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);
const globalLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, GLOBAL_RATE_LIMIT_MAX);
const replayCache = new ReplayCache(REPLAY_TTL_MS);
// Event buffer to merge related text + image events
const eventBuffer = new EventBuffer(2000); // Wait 2s to collect related events

async function readRawBody(req: any): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: any, res: any) {
  // Read just what's needed without importing strict env parser
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN as string | undefined;
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN as string | undefined;
  const APP_SECRET = process.env.APP_SECRET as string | undefined;

  if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !APP_SECRET) {
    logger.error('Server misconfigured');
    res.statusCode = 500;
    res.end('Server misconfigured');
    return;
  }

  if (req.method === 'GET') {
    const mode = req.query?.['hub.mode'] as string | undefined;
    const token = req.query?.['hub.verify_token'] as string | undefined;
    const challenge = req.query?.['hub.challenge'] as string | undefined;
    
    const verificationResult = VERIFY_TOKEN
      ? verifyWebhookChallenge(mode, token, challenge, VERIFY_TOKEN)
      : null;
    
    if (verificationResult) {
      res.statusCode = 200;
      res.end(verificationResult);
    } else {
      res.statusCode = 403;
      res.end('Forbidden');
    }
    return;
  }

  if (req.method === 'POST') {
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers?.['x-hub-signature-256'] as string | undefined;
    
    if (!APP_SECRET || !verifyWebhookSignature(rawBody, signatureHeader, APP_SECRET)) {
      res.statusCode = 401;
      res.end('Unauthorized');
      return;
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.statusCode = 400;
      res.end('Invalid JSON');
      return;
    }

    if (body.object !== 'page') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // Global limiter (drop batch if exceeded)
    if (!globalLimiter.allowEvent('global')) {
      logger.warn('Global rate limit exceeded (serverless)');
      res.statusCode = 429;
      res.end('Too Many Requests');
      return;
    }

    const events = extractMessagingEvents(body);
    const tasks: Promise<void>[] = [];

    // Process each messaging event
    for (const event of events) {
      const { senderId, messageText, mid, imageUrl } = event;

      // Replay protection by message ID
      if (mid && replayCache.seen(mid)) {
        logger.debug({ mid }, 'Replay detected: duplicate message id');
        continue;
      }

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
        tasks.push((async () => {
          try {
            // Lazy-import heavy modules to keep GET lightweight and avoid env parsing side-effects
            const { handleConversation } = await import('../src/conversation');
            const { sendSenderAction, sendTextMessage, sendProductCarousel } = await import('../src/social/facebook');

            await sendSenderAction(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, 'typing_on');
            
            // Prepare conversation options (with merged text + image)
            const conversationOpts = {
              mid: mergedEvent.mid,
              ...(mergedEvent.imageUrl ? { imageUrl: mergedEvent.imageUrl } : {})
            };
            
            const resp = await handleConversation(mergedEvent.senderId, mergedEvent.messageText, conversationOpts);
            
            if (resp.products && resp.products.length > 0) {
              await sendProductCarousel(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, resp.products);
            }
            
            await sendTextMessage(PAGE_ACCESS_TOKEN!, mergedEvent.senderId, resp.text);
          } catch (err: any) {
            logger.error({ err, senderId: mergedEvent.senderId }, 'Failed to handle message event');
          }
        })());
      });
    }

    // IMPORTANT: Must await in serverless - execution stops after response
    await Promise.allSettled(tasks);
    res.statusCode = 200;
    res.end('OK');
    return;
  }

  res.statusCode = 405;
  res.setHeader('Allow', 'GET, POST');
  res.end('Method Not Allowed');
}


