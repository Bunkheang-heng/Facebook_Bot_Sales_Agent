import crypto from 'crypto';
import { logger } from '../core/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const SIGNATURE_PREFIX = 'sha256=';
const MAX_SIGNATURE_LENGTH = 100;
const MAX_MESSAGE_TEXT_LENGTH = 5000;
const MAX_IMAGE_URL_LENGTH = 2000;
const MAX_SENDER_ID_LENGTH = 100;
const MAX_MESSAGE_ID_LENGTH = 100;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Represents a messaging event from Facebook webhook
 */
export interface MessagingEvent {
  senderId: string;
  messageText: string;
  mid: string | undefined;
  imageUrl?: string;
  hasImage: boolean;
}

/**
 * Internal representation of Facebook webhook entry
 */
interface WebhookEntry {
  messaging?: Array<{
    sender?: { id?: string };
    message?: {
      text?: string;
      mid?: string;
      attachments?: Array<{
        type?: string;
        payload?: { url?: string };
      }>;
    };
  }>;
}

/**
 * Facebook webhook payload structure
 */
interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

// ============================================================================
// SIGNATURE VERIFICATION
// ============================================================================

/**
 * Validate signature header format
 */
function isValidSignatureFormat(signature: string): boolean {
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    logger.warn({ prefix: signature.slice(0, 10) }, 'Signature missing sha256= prefix');
    return false;
  }

  if (signature.length > MAX_SIGNATURE_LENGTH) {
    logger.warn({ length: signature.length }, 'Signature exceeds maximum length');
    return false;
  }

  // Check if hex string after prefix
  const hexPart = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]+$/i.test(hexPart)) {
    logger.warn('Signature contains invalid characters');
    return false;
  }

  return true;
}

/**
 * Compute HMAC SHA256 signature for request body
 */
function computeSignature(rawBody: Buffer, appSecret: string): string {
  return SIGNATURE_PREFIX + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
}

/**
 * Verify Facebook webhook signature using HMAC SHA256
 * 
 * This prevents unauthorized requests from impersonating Facebook.
 * Facebook signs each webhook request with your App Secret.
 * 
 * @param rawBody - Raw request body buffer (must not be parsed yet)
 * @param signatureHeader - Value of x-hub-signature-256 header
 * @param appSecret - Your Facebook App Secret from environment variables
 * @returns true if signature is valid, false otherwise
 * 
 * @security Critical security function - prevents webhook spoofing
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  // Validate inputs
  if (!signatureHeader) {
    logger.warn('Webhook signature header is missing');
    return false;
  }

  if (!Buffer.isBuffer(rawBody)) {
    logger.error({ type: typeof rawBody }, 'Raw body is not a Buffer');
    return false;
  }

  if (!appSecret || typeof appSecret !== 'string') {
    logger.error('App secret is missing or invalid');
    return false;
  }

  if (rawBody.length === 0) {
    logger.warn('Raw body is empty');
    return false;
  }

  // Validate signature format
  if (!isValidSignatureFormat(signatureHeader)) {
    return false;
  }

  // Compute expected signature
  const expectedSignature = computeSignature(rawBody, appSecret);

  // Use timing-safe comparison to prevent timing attacks
  try {
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

    // Length check before timing-safe comparison
    if (expectedBuffer.length !== receivedBuffer.length) {
      logger.warn(
        { 
          expectedLength: expectedBuffer.length, 
          receivedLength: receivedBuffer.length 
        }, 
        'Signature length mismatch'
      );
      return false;
    }

    // Timing-safe comparison prevents timing attacks
    const isValid = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

    if (!isValid) {
      logger.error(
        { 
          bodySize: rawBody.length,
          signaturePrefix: signatureHeader.slice(0, 15) 
        }, 
        'Webhook signature verification failed'
      );
    }

    return isValid;

  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : 'Unknown error' }, 
      'Error during signature comparison'
    );
    return false;
  }
}

// ============================================================================
// WEBHOOK CHALLENGE VERIFICATION
// ============================================================================

/**
 * Verify webhook subscription challenge (used during webhook setup)
 * 
 * When you configure a webhook in Facebook Developer Console, Facebook
 * sends a GET request to verify you own the endpoint.
 * 
 * @param mode - hub.mode query parameter (should be "subscribe")
 * @param token - hub.verify_token query parameter (your secret token)
 * @param challenge - hub.challenge query parameter (random string from Facebook)
 * @param expectedToken - Your verify token from environment variables
 * @returns challenge string to echo back, or null if verification fails
 * 
 * @security Only called during initial webhook setup, not for regular messages
 */
export function verifyWebhookChallenge(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
  expectedToken: string
): string | null {
  // Validate inputs
  if (!mode || typeof mode !== 'string') {
    logger.warn({ mode }, 'Invalid or missing hub.mode');
    return null;
  }

  if (!token || typeof token !== 'string') {
    logger.warn('Missing hub.verify_token');
    return null;
  }

  if (!challenge || typeof challenge !== 'string') {
    logger.warn('Missing hub.challenge');
    return null;
  }

  if (!expectedToken || typeof expectedToken !== 'string') {
    logger.error('Expected token is not configured');
    return null;
  }

  // Verify mode and token
  const modeMatches = mode === 'subscribe';
  const tokenMatches = token === expectedToken;

  if (modeMatches && tokenMatches) {
    logger.info(
      { challengeLength: challenge.length }, 
      '✅ Webhook verification successful'
    );
    return challenge;
  }

  // Log failure details (without exposing tokens)
  logger.warn(
    { 
      mode, 
      modeMatches, 
      tokenMatches,
      tokenLength: token.length,
      expectedTokenLength: expectedToken.length
    }, 
    '❌ Webhook verification failed'
  );

  return null;
}

// ============================================================================
// EVENT EXTRACTION & VALIDATION
// ============================================================================

/**
 * Validate and sanitize sender ID
 */
function sanitizeSenderId(senderId: string | undefined): string | null {
  if (!senderId || typeof senderId !== 'string') {
    return null;
  }

  const trimmed = senderId.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_SENDER_ID_LENGTH) {
    logger.warn({ length: trimmed.length }, 'Invalid sender ID length');
    return null;
  }

  // Facebook sender IDs should be numeric
  if (!/^\d+$/.test(trimmed)) {
    logger.warn({ senderId: trimmed.slice(0, 20) }, 'Invalid sender ID format');
    return null;
  }

  return trimmed;
}

/**
 * Validate and sanitize message ID
 */
function sanitizeMessageId(mid: string | undefined): string | null {
  if (!mid || typeof mid !== 'string') {
    return null;
  }

  const trimmed = mid.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_ID_LENGTH) {
    return null;
  }

  return trimmed;
}

/**
 * Validate and sanitize message text
 */
function sanitizeMessageText(text: string | undefined): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Remove null bytes and other control characters
  const cleaned = text
    .replace(/\0/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .trim();

  // Limit length
  if (cleaned.length > MAX_MESSAGE_TEXT_LENGTH) {
    logger.warn(
      { originalLength: text.length, truncatedLength: MAX_MESSAGE_TEXT_LENGTH }, 
      'Message text truncated'
    );
    return cleaned.slice(0, MAX_MESSAGE_TEXT_LENGTH);
  }

  return cleaned;
}

/**
 * Validate and sanitize image URL
 */
function sanitizeImageUrl(url: string | undefined): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim();

  // Validate URL format
  if (!trimmed.startsWith('https://')) {
    logger.warn({ urlPrefix: trimmed.slice(0, 20) }, 'Image URL is not HTTPS');
    return null;
  }

  if (trimmed.length > MAX_IMAGE_URL_LENGTH) {
    logger.warn({ length: trimmed.length }, 'Image URL exceeds maximum length');
    return null;
  }

  // Basic URL validation
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    logger.warn({ url: trimmed.slice(0, 50) }, 'Invalid image URL format');
    return null;
  }
}

/**
 * Extract image attachment from message
 */
function extractImageAttachment(attachments: any[]): string | null {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  for (const attachment of attachments) {
    if (attachment?.type === 'image' && attachment?.payload?.url) {
      const sanitizedUrl = sanitizeImageUrl(attachment.payload.url);
      if (sanitizedUrl) {
        return sanitizedUrl;
      }
    }
  }

  return null;
}

/**
 * Validate webhook payload structure
 */
function isValidWebhookPayload(body: any): body is WebhookPayload {
  if (!body || typeof body !== 'object') {
    logger.warn('Webhook payload is not an object');
    return false;
  }

  if (body.object !== 'page') {
    logger.debug({ object: body.object }, 'Non-page webhook object received');
    return false;
  }

  if (!Array.isArray(body.entry)) {
    logger.warn('Webhook payload missing entry array');
    return false;
  }

  return true;
}

/**
 * Process a single messaging event from webhook entry
 */
function processMessagingEvent(
  event: any,
  seenMids: Set<string>
): MessagingEvent | null {
  // Extract and validate sender ID
  const senderId = sanitizeSenderId(event?.sender?.id);
  if (!senderId) {
    logger.debug('Skipping event: invalid sender ID');
    return null;
  }

  // Extract message data
  const messageText = sanitizeMessageText(event?.message?.text);
  const mid = sanitizeMessageId(event?.message?.mid);
  const attachments = event?.message?.attachments ?? [];

      // Deduplicate by message ID
      if (mid && seenMids.has(mid)) {
    logger.debug({ mid, senderId }, 'Duplicate message ID detected, skipping');
    return null;
      }

      if (mid) {
        seenMids.add(mid);
      }

  // Extract image attachment
  const imageUrl = extractImageAttachment(attachments);

  // Validate that we have either text or image
  const hasText = messageText.length > 0;
  const hasImage = !!imageUrl;

  if (!hasText && !hasImage) {
    logger.debug({ senderId }, 'Skipping event: no text or image');
    return null;
  }

  // Log image detection
  if (hasImage && imageUrl) {
    logger.info(
      { senderId, imageUrl: imageUrl.slice(0, 80), hasText }, 
      '📸 Image attachment detected'
    );
  }

  // Create messaging event
  const messagingEvent: MessagingEvent = {
          senderId,
    messageText,
    mid: mid ?? undefined,
          hasImage
        };
        
        // Only add imageUrl if it exists
        if (imageUrl) {
    messagingEvent.imageUrl = imageUrl;
  }

  return messagingEvent;
}

/**
 * Parse and extract messaging events from Facebook webhook payload
 * 
 * Validates, sanitizes, and extracts all messaging events from the webhook payload.
 * Handles both text messages and image attachments.
 * 
 * @param body - Raw webhook request body (already parsed JSON)
 * @returns Array of validated messaging events
 * 
 * @security Includes input validation and sanitization to prevent injection
 */
export function extractMessagingEvents(body: any): MessagingEvent[] {
  const events: MessagingEvent[] = [];
  const seenMids = new Set<string>();

  // Validate payload structure
  if (!isValidWebhookPayload(body)) {
    return events;
  }

  // Process each entry
  for (const entry of body.entry ?? []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const messagingEvents = entry.messaging;
    if (!Array.isArray(messagingEvents)) {
      continue;
    }

    // Process each messaging event
    for (const event of messagingEvents) {
      const messagingEvent = processMessagingEvent(event, seenMids);
      if (messagingEvent) {
        events.push(messagingEvent);
      }
    }
  }

  // Log summary
  logger.info(
    {
      totalEvents: events.length,
      withImages: events.filter(e => e.hasImage).length,
      textOnly: events.filter(e => !e.hasImage).length,
      withText: events.filter(e => e.messageText.length > 0).length
    },
    '📨 Messaging events extracted and validated'
  );

  return events;
}
