import { logger } from '../src/core/logger';
import { RateLimiter } from '../src/security/rate-limiter';
import { ReplayCache } from '../src/security/replay-cache';
import { EventBuffer } from '../src/social/event-buffer';
import { verifyWebhookSignature, verifyWebhookChallenge, extractMessagingEvents } from '../src/security/webhook';
import { clampText } from '../src/utils/text';
import { MAX_MESSAGE_CHARS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS, GLOBAL_RATE_LIMIT_MAX, REPLAY_TTL_MS, MAX_EVENT_AGE_MS } from '../src/security/constants';

// ============================================================================
// CONSTANTS
// ============================================================================

const ERROR_MESSAGES = {
  SERVER_MISCONFIGURED: 'Server misconfigured',
  FORBIDDEN: 'Forbidden',
  UNAUTHORIZED: 'Unauthorized',
  INVALID_JSON: 'Invalid JSON',
  NOT_FOUND: 'Not Found',
  TOO_MANY_REQUESTS: 'Too Many Requests',
  METHOD_NOT_ALLOWED: 'Method Not Allowed'
} as const;

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR: 500
} as const;

// ============================================================================
// STATE (Preserved in warm containers)
// ============================================================================

const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);
const globalLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, GLOBAL_RATE_LIMIT_MAX);
const replayCache = new ReplayCache(REPLAY_TTL_MS);
const eventBuffer = new EventBuffer(2000);

// ============================================================================
// TYPES
// ============================================================================

interface WebhookRequest {
  method: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: any;
}

interface WebhookResponse {
  statusCode: number;
  end: (data: string) => void;
  setHeader: (name: string, value: string) => void;
}

interface EnvVars {
  PAGE_ACCESS_TOKEN: string;
  VERIFY_TOKEN: string;
  APP_SECRET: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read and buffer the raw request body
 */
async function readRawBody(req: any): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      reject(new Error('Request body read timeout'));
    }, 10000); // 10s timeout

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // Prevent memory exhaustion
      if (Buffer.concat(chunks).length > 1024 * 200) { // 200KB max
        clearTimeout(timeout);
        reject(new Error('Request body too large'));
      }
    });

    req.on('end', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Validate and retrieve required environment variables
 */
function getEnvVars(): EnvVars | null {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const APP_SECRET = process.env.APP_SECRET;

  if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !APP_SECRET) {
    logger.error({ 
      hasToken: !!PAGE_ACCESS_TOKEN, 
      hasVerifyToken: !!VERIFY_TOKEN, 
      hasSecret: !!APP_SECRET 
    }, 'Missing required environment variables');
    return null;
  }

  return { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APP_SECRET };
}

/**
 * Send standardized response
 */
function sendResponse(res: WebhookResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.end(message);
}

/**
 * Sanitize query parameters to prevent injection
 */
function sanitizeQueryParam(param: any): string | undefined {
  if (!param || typeof param !== 'string') {
    return undefined;
  }
  // Remove any control characters and limit length
  return param.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500);
}

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

/**
 * Handle GET request - Webhook verification
 */
function handleWebhookVerification(req: WebhookRequest, res: WebhookResponse, verifyToken: string): void {
  const mode = sanitizeQueryParam(req.query?.['hub.mode']);
  const token = sanitizeQueryParam(req.query?.['hub.verify_token']);
  const challenge = sanitizeQueryParam(req.query?.['hub.challenge']);

  logger.info({ mode, hasToken: !!token, hasChallenge: !!challenge }, 'Webhook verification request received');

  const verificationResult = verifyWebhookChallenge(mode, token, challenge, verifyToken);

  if (verificationResult) {
    logger.info('Webhook verification successful');
    sendResponse(res, HTTP_STATUS.OK, verificationResult);
  } else {
    logger.warn({ mode, tokenMatch: token === verifyToken }, 'Webhook verification failed');
    sendResponse(res, HTTP_STATUS.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
  }
}

/**
 * Validate webhook signature for POST requests
 */
function validateWebhookSecurity(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader) {
    logger.warn('Missing webhook signature header');
    return false;
  }

  const isValid = verifyWebhookSignature(rawBody, signatureHeader, appSecret);
  
  if (!isValid) {
    logger.error({ signaturePresent: !!signatureHeader }, 'Invalid webhook signature');
  }

  return isValid;
}

/**
 * Parse and validate request body
 */
function parseRequestBody(rawBody: Buffer): any | null {
  try {
    const bodyStr = rawBody.toString('utf8');
    // Additional validation: check for valid JSON characters
    if (!/^[\x20-\x7E\s]*$/.test(bodyStr.slice(0, 100))) {
      logger.warn('Request body contains invalid characters');
      return null;
    }
    return JSON.parse(bodyStr);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : 'Unknown' }, 'Failed to parse request body');
    return null;
  }
}

/**
 * Validate webhook payload structure
 */
function validateWebhookPayload(body: any): boolean {
  if (!body || typeof body !== 'object') {
    logger.warn('Invalid webhook payload: not an object');
    return false;
  }

  if (body.object !== 'page') {
    logger.warn({ object: body.object }, 'Invalid webhook payload: wrong object type');
    return false;
  }

  return true;
}

/**
 * Check if event should be processed
 */
function shouldProcessEvent(
  senderId: string,
  mid: string | undefined,
  entryTime: number | undefined
): { allowed: boolean; reason?: string } {
  // Replay protection
  if (mid && replayCache.seen(mid)) {
    logger.debug({ mid, senderId }, 'Event rejected: replay detected');
    return { allowed: false, reason: 'replay' };
  }

  // Age check
  if (entryTime && (Date.now() - entryTime) > MAX_EVENT_AGE_MS) {
    logger.warn({ senderId, age: Date.now() - entryTime }, 'Event rejected: too old');
    return { allowed: false, reason: 'stale' };
  }

  // Rate limiting
  if (!rateLimiter.allowEvent(senderId)) {
    logger.warn({ senderId }, 'Event rejected: rate limit exceeded');
    return { allowed: false, reason: 'rate_limit' };
  }

  return { allowed: true };
}

/**
 * Process a single messaging event
 */
async function processMessagingEvent(
  event: ReturnType<typeof extractMessagingEvents>[0],
  entryTime: number | undefined,
  pageAccessToken: string
): Promise<void> {
  const { senderId, messageText, mid, imageUrl } = event;

  // Security checks
  const checkResult = shouldProcessEvent(senderId, mid, entryTime);
  if (!checkResult.allowed) {
    return;
  }

  // Sanitize message text
  const clipped = clampText(messageText, MAX_MESSAGE_CHARS);

  // Buffer events to merge text + image
  eventBuffer.addEvent(senderId, clipped, imageUrl, mid, async (mergedEvent) => {
    try {
      // Lazy-import heavy modules for performance
      const { handleConversation } = await import('../src/core/conversation');
      const { sendSenderAction, sendTextMessage, sendProductCarousel } = await import('../src/social/facebook');

      // Show typing indicator
      await sendSenderAction(pageAccessToken, mergedEvent.senderId, 'typing_on').catch(err => {
        logger.debug({ error: err.message }, 'Failed to send typing indicator');
      });

      // Process conversation
      const conversationOpts = {
        mid: mergedEvent.mid,
        ...(mergedEvent.imageUrl ? { imageUrl: mergedEvent.imageUrl } : {})
      };

      const response = await handleConversation(
        mergedEvent.senderId,
        mergedEvent.messageText,
        conversationOpts
      );

      // Send product carousel if available
      if (response.products && response.products.length > 0) {
        await sendProductCarousel(pageAccessToken, mergedEvent.senderId, response.products).catch(err => {
          logger.error({ error: err.message, senderId: mergedEvent.senderId }, 'Failed to send product carousel');
        });
      }

      // Send text response
      await sendTextMessage(pageAccessToken, mergedEvent.senderId, response.text);

      logger.info({ senderId: mergedEvent.senderId, hasProducts: !!response.products }, 'Message processed successfully');

    } catch (err: any) {
      logger.error({ 
        error: err.message, 
        stack: err.stack?.slice(0, 500),
        senderId: mergedEvent.senderId 
      }, 'Failed to process message event');
    }
  });
}

/**
 * Handle POST request - Process incoming messages
 */
async function handleWebhookMessage(
  req: WebhookRequest,
  res: WebhookResponse,
  envVars: EnvVars
): Promise<void> {
  // Read raw body
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : 'Unknown' }, 'Failed to read request body');
    sendResponse(res, HTTP_STATUS.BAD_REQUEST, ERROR_MESSAGES.INVALID_JSON);
    return;
  }

  // Validate signature
  const signatureHeader = req.headers?.['x-hub-signature-256'];
  if (!validateWebhookSecurity(rawBody, signatureHeader, envVars.APP_SECRET)) {
    sendResponse(res, HTTP_STATUS.UNAUTHORIZED, ERROR_MESSAGES.UNAUTHORIZED);
    return;
  }

  // Parse body
  const body = parseRequestBody(rawBody);
  if (!body) {
    sendResponse(res, HTTP_STATUS.BAD_REQUEST, ERROR_MESSAGES.INVALID_JSON);
    return;
  }

  // Validate payload
  if (!validateWebhookPayload(body)) {
    sendResponse(res, HTTP_STATUS.NOT_FOUND, ERROR_MESSAGES.NOT_FOUND);
    return;
  }

  // Global rate limiting
  if (!globalLimiter.allowEvent('global')) {
    logger.warn('Global rate limit exceeded');
    sendResponse(res, HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_MESSAGES.TOO_MANY_REQUESTS);
    return;
  }

  // Extract and process events
  const events = extractMessagingEvents(body);
  const entryTime = body.entry?.[0]?.time ? Number(body.entry[0].time) : undefined;

  logger.info({ eventCount: events.length, entryTime }, 'Processing webhook events');

  // Process all events (in parallel for serverless)
  const tasks = events.map(event => 
    processMessagingEvent(event, entryTime, envVars.PAGE_ACCESS_TOKEN)
  );

  // CRITICAL: Must await in serverless - execution stops after response
  await Promise.allSettled(tasks);

  sendResponse(res, HTTP_STATUS.OK, 'OK');
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Main webhook handler for Facebook Messenger
 * Handles both verification (GET) and message processing (POST)
 */
export default async function handler(req: WebhookRequest, res: WebhookResponse): Promise<void> {
  const startTime = Date.now();

  // Validate environment variables
  const envVars = getEnvVars();
  if (!envVars) {
    sendResponse(res, HTTP_STATUS.SERVER_ERROR, ERROR_MESSAGES.SERVER_MISCONFIGURED);
    return;
  }

  try {
    // Route based on HTTP method
    if (req.method === 'GET') {
      handleWebhookVerification(req, res, envVars.VERIFY_TOKEN);
    } else if (req.method === 'POST') {
      await handleWebhookMessage(req, res, envVars);
    } else {
      logger.warn({ method: req.method }, 'Unsupported HTTP method');
      res.setHeader('Allow', 'GET, POST');
      sendResponse(res, HTTP_STATUS.METHOD_NOT_ALLOWED, ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }

    const duration = Date.now() - startTime;
    logger.info({ method: req.method, duration, statusCode: res.statusCode }, 'Webhook request completed');

  } catch (err: any) {
    // Catch-all error handler
    logger.error({ 
      error: err.message, 
      stack: err.stack?.slice(0, 1000),
      method: req.method 
    }, 'Unhandled webhook error');
    
    sendResponse(res, HTTP_STATUS.SERVER_ERROR, ERROR_MESSAGES.SERVER_MISCONFIGURED);
  }
}
