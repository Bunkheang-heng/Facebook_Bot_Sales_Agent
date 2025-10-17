import dotenv from 'dotenv';
dotenv.config();

import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import { sendTextMessage } from './social/facebook';
import { handleConversation } from './conversation';
import helmet from 'helmet';
import compression from 'compression';

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

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const PORT = Number(process.env.PORT || 3000);
const MAX_MESSAGE_CHARS = 800;
const RATE_LIMIT_WINDOW_MS = 30_000; // 30s
const RATE_LIMIT_MAX_EVENTS = 4; // per window per user

type RateBucket = { count: number; resetAt: number };
const userRateBuckets: Map<string, RateBucket> = new Map();

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

if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !APP_SECRET) {
  // Fail fast so misconfiguration is caught immediately
  throw new Error('Missing required env vars: PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APP_SECRET');
}

function verifyRequestSignature(req: Request & { rawBody?: Buffer }) {
  const signatureHeader = req.header('x-hub-signature-256');
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET!)
    .update(req.rawBody ?? Buffer.from(''))
    .digest('hex');
  const received = signatureHeader;
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(received);
  return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// Webhook verification endpoint (required by Meta)
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ''));
  } else {
    res.sendStatus(403);
  }
});

// Event receiver
app.post('/webhook', (req: Request & { rawBody?: Buffer }, res: Response) => {
  if (!verifyRequestSignature(req)) {
    return res.sendStatus(401);
  }

  const body = req.body as any;
  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  // Deduplicate by message mid
  const seenMids = new Set<string>();

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const messageText: string | undefined = event.message?.text;
      const mid: string | undefined = event.message?.mid;
      if (mid) {
        if (seenMids.has(mid)) {
          continue;
        }
        seenMids.add(mid);
      }
      if (senderId && typeof messageText === 'string' && messageText.trim().length > 0) {
        if (!allowEventForUser(senderId)) {
          continue;
        }
        const clipped = messageText.trim().slice(0, MAX_MESSAGE_CHARS);
        handleConversation(senderId, clipped)
          .then((reply) => {
            return sendTextMessage(PAGE_ACCESS_TOKEN!, senderId, reply);
          })
          .catch((err) => {
            console.error('Failed to generate/send AI reply', err?.response?.data ?? err);
          });
      }
    }
  }

  res.sendStatus(200);
});

app.get('/', (_req, res) => {
  res.status(200).send('Messenger bot is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


