import { env } from '../src/config';
import { logger } from '../src/logger';
import { handleConversation } from '../src/conversation';
import { sendSenderAction, sendTextMessage, sendProductCarousel } from '../src/social/facebook';
import { RateLimiter } from '../src/utils/rate-limiter';
import { verifyWebhookSignature, verifyWebhookChallenge, extractMessagingEvents } from '../src/utils/webhook';
import { clampText } from '../src/utils/text';

const MAX_MESSAGE_CHARS = 800;
const RATE_LIMIT_WINDOW_MS = 30_000;
const RATE_LIMIT_MAX_EVENTS = 4;

// Initialize rate limiter (persists across serverless invocations in warm container)
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);

async function readRawBody(req: any): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: any, res: any) {
  const PAGE_ACCESS_TOKEN = env.PAGE_ACCESS_TOKEN;
  const VERIFY_TOKEN = env.VERIFY_TOKEN;
  const APP_SECRET = env.APP_SECRET;

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
    
    const verificationResult = verifyWebhookChallenge(mode, token, challenge, VERIFY_TOKEN);
    
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
    
    if (!verifyWebhookSignature(rawBody, signatureHeader, APP_SECRET)) {
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

    const events = extractMessagingEvents(body);
    const tasks: Promise<void>[] = [];

    // Process each messaging event
    for (const event of events) {
      const { senderId, messageText, mid, imageUrl, hasImage } = event;

      // Apply rate limiting
      if (!rateLimiter.allowEvent(senderId)) {
        logger.warn({ senderId }, 'Rate limit exceeded, skipping event');
        continue;
      }

      const clipped = clampText(messageText, MAX_MESSAGE_CHARS);
      
      tasks.push((async () => {
        try {
          await sendSenderAction(PAGE_ACCESS_TOKEN, senderId, 'typing_on');
          
          // Prepare conversation options (with image if present)
          const conversationOpts = {
            mid,
            ...(hasImage && imageUrl ? { imageUrl } : {})
          };
          
          const resp = await handleConversation(senderId, clipped, conversationOpts);
          
          if (resp.products && resp.products.length > 0) {
            await sendProductCarousel(PAGE_ACCESS_TOKEN, senderId, resp.products);
          }
          
          await sendTextMessage(PAGE_ACCESS_TOKEN, senderId, resp.text);
        } catch (err: any) {
          logger.error({ err, senderId }, 'Failed to handle message event');
        }
      })());
    }

    void Promise.allSettled(tasks);
    res.statusCode = 200;
    res.end('OK');
    return;
  }

  res.statusCode = 405;
  res.setHeader('Allow', 'GET, POST');
  res.end('Method Not Allowed');
}


