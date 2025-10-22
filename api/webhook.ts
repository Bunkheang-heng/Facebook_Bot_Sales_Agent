import crypto from 'crypto';
import { env } from '../src/config';
import { logger } from '../src/logger';
import { handleConversation } from '../src/conversation';
import { sendSenderAction, sendTextMessage, sendProductCarousel } from '../src/social/facebook';

type RateBucket = { count: number; resetAt: number };
const userRateBuckets: Map<string, RateBucket> = new Map();
const MAX_MESSAGE_CHARS = 800;
const RATE_LIMIT_WINDOW_MS = 30_000;
const RATE_LIMIT_MAX_EVENTS = 4;

function allowEventForUser(userId: string): boolean {
  const now = Date.now();
  const bucket = userRateBuckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    userRateBuckets.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count < RATE_LIMIT_MAX_EVENTS) {
    bucket.count += 1;
    return true;
  }
  return false;
}

async function readRawBody(req: any): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);
  return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
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
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.statusCode = 200;
      res.end(String(challenge ?? ''));
    } else {
      res.statusCode = 403;
      res.end('Forbidden');
    }
    return;
  }

  if (req.method === 'POST') {
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers?.['x-hub-signature-256'] as string | undefined;
    if (!verifySignature(rawBody, signatureHeader, APP_SECRET)) {
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

    const seenMids = new Set<string>();
    const tasks: Promise<void>[] = [];

    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const senderId: string | undefined = event.sender?.id;
        const messageText: string | undefined = event.message?.text;
        const mid: string | undefined = event.message?.mid;
        if (mid) {
          if (seenMids.has(mid)) continue;
          seenMids.add(mid);
        }
        if (senderId && typeof messageText === 'string' && messageText.trim().length > 0) {
          if (!allowEventForUser(senderId)) continue;
          const clipped = messageText.trim().slice(0, MAX_MESSAGE_CHARS);
          tasks.push((async () => {
            try {
              await sendSenderAction(PAGE_ACCESS_TOKEN, senderId, 'typing_on');
              const resp = await handleConversation(senderId, clipped, mid ? { mid } : undefined);
              if (resp.products && resp.products.length > 0) {
                await sendProductCarousel(PAGE_ACCESS_TOKEN, senderId, resp.products);
              }
              await sendTextMessage(PAGE_ACCESS_TOKEN, senderId, resp.text);
            } catch (err: any) {
              console.error('Failed to handle message event', err?.response?.data ?? err);
            }
          })());
        }
      }
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


