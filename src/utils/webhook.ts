import crypto from 'crypto';
import { logger } from '../logger';

/**
 * Verify Facebook webhook signature using HMAC SHA256
 * @param rawBody Raw request body buffer
 * @param signatureHeader x-hub-signature-256 header value
 * @param appSecret Facebook App Secret
 * @returns true if signature is valid, false otherwise
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    logger.warn('Missing or invalid signature header');
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Extract messaging events from webhook payload
 */
export type MessagingEvent = {
  senderId: string;
  messageText: string;
  mid: string | undefined;
};

/**
 * Parse and extract messaging events from Facebook webhook payload
 * @param body Webhook request body
 * @returns Array of messaging events
 */
export function extractMessagingEvents(body: any): MessagingEvent[] {
  const events: MessagingEvent[] = [];
  const seenMids = new Set<string>();

  if (body.object !== 'page') {
    logger.debug({ object: body.object }, 'Non-page webhook object received');
    return events;
  }

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId: string | undefined = event.sender?.id;
      const messageText: string | undefined = event.message?.text;
      const mid: string | undefined = event.message?.mid;

      // Deduplicate by message ID
      if (mid && seenMids.has(mid)) {
        logger.debug({ mid }, 'Duplicate message ID detected, skipping');
        continue;
      }
      if (mid) {
        seenMids.add(mid);
      }

      // Validate required fields
      if (senderId && typeof messageText === 'string' && messageText.trim().length > 0) {
        events.push({ senderId, messageText, mid });
      }
    }
  }

  return events;
}

/**
 * Verify webhook subscription challenge (used during webhook setup)
 * @param mode hub.mode query parameter
 * @param token hub.verify_token query parameter
 * @param challenge hub.challenge query parameter
 * @param expectedToken Expected verify token
 * @returns challenge string if verification succeeds, null otherwise
 */
export function verifyWebhookChallenge(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
  expectedToken: string
): string | null {
  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('Webhook verification successful');
    return String(challenge ?? '');
  }
  logger.warn({ mode, tokenMatch: token === expectedToken }, 'Webhook verification failed');
  return null;
}

