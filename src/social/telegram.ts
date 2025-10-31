import axios, { AxiosInstance } from 'axios';
import http from 'node:http';
import https from 'node:https';
import type { RetrievedProduct } from '../services/rag';
import { logger } from '../core/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_MESSAGE_LENGTH = 4096; // Telegram's limit
const MAX_CAPTION_LENGTH = 1024;
const MAX_PRODUCTS_IN_CAROUSEL = 10;

// ============================================================================
// AXIOS INSTANCE
// ============================================================================

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

let telegramClient: AxiosInstance | null = null;

/**
 * Get or create Telegram API client
 */
function getTelegramClient(botToken: string): AxiosInstance {
  if (!telegramClient) {
    telegramClient = axios.create({
      baseURL: `${TELEGRAM_API_BASE_URL}/bot${botToken}`,
      timeout: DEFAULT_TIMEOUT,
      httpAgent,
      httpsAgent,
      validateStatus: (status) => status < 500 // Don't throw on 4xx errors
    });
  }
  return telegramClient;
}

// ============================================================================
// TYPES
// ============================================================================

export interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  date: number;
  text?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    width: number;
    height: number;
  }>;
  caption?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramMessage['from'];
    message?: TelegramMessage;
    data?: string;
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Retry helper for transient network errors
 */
async function retryOnTimeout<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      const is5xx = err.response?.status >= 500 && err.response?.status < 600;
      const shouldRetry = (isTimeout || is5xx) && attempt < retries;

      if (shouldRetry) {
        logger.warn(
          { 
            attempt: attempt + 1, 
            error: err.message,
            status: err.response?.status 
          },
          'Retrying Telegram API call'
        );
        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Retry exhausted');
}

/**
 * Validate Telegram bot token format
 */
function isValidBotToken(token: string): boolean {
  // Telegram bot token format: <bot_id>:<auth_token>
  // Example: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz-1234567890
  return /^\d+:[A-Za-z0-9_-]{35,}$/.test(token);
}

/**
 * Split long text into multiple messages if needed
 */
function splitLongText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a sentence boundary
    let splitIndex = remaining.lastIndexOf('. ', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at a space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Just split at maxLength
      splitIndex = maxLength;
    } else {
      splitIndex += 1; // Include the period
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks;
}

/**
 * Handle Telegram API errors
 */
function handleTelegramError(error: any, operation: string): void {
  const status = error.response?.status;
  const errorCode = error.response?.data?.error_code;
  const description = error.response?.data?.description;

  logger.error(
    {
      operation,
      status,
      errorCode,
      description,
      message: error.message
    },
    '❌ Telegram API error'
  );

  // Log specific error types
  if (errorCode === 403) {
    logger.warn({ operation }, 'Bot was blocked by user or chat not found');
  } else if (errorCode === 429) {
    logger.warn({ operation }, 'Too many requests - rate limited');
  } else if (errorCode === 400) {
    logger.warn({ operation, description }, 'Bad request to Telegram API');
  }
}

// ============================================================================
// WEBHOOK SETUP
// ============================================================================

/**
 * Set webhook URL for receiving updates
 */
export async function setWebhook(
  botToken: string,
  webhookUrl: string,
  options?: {
    maxConnections?: number;
    allowedUpdates?: string[];
    dropPendingUpdates?: boolean;
  }
): Promise<boolean> {
  if (!isValidBotToken(botToken)) {
    throw new Error('Invalid Telegram bot token format');
  }

  if (!webhookUrl.startsWith('https://')) {
    throw new Error('Webhook URL must use HTTPS');
  }

  const client = getTelegramClient(botToken);

  try {
    const response = await client.post('/setWebhook', {
      url: webhookUrl,
      max_connections: options?.maxConnections || 40,
      allowed_updates: options?.allowedUpdates || ['message', 'callback_query'],
      drop_pending_updates: options?.dropPendingUpdates || false
    });

    if (response.data?.ok) {
      logger.info({ webhookUrl }, '✅ Telegram webhook set successfully');
      return true;
    } else {
      logger.error({ response: response.data }, 'Failed to set Telegram webhook');
      return false;
    }
  } catch (error) {
    handleTelegramError(error, 'setWebhook');
    return false;
  }
}

/**
 * Get current webhook info
 */
export async function getWebhookInfo(botToken: string): Promise<any> {
  const client = getTelegramClient(botToken);

  try {
    const response = await client.get('/getWebhookInfo');
    return response.data?.result;
  } catch (error) {
    handleTelegramError(error, 'getWebhookInfo');
    return null;
  }
}

/**
 * Delete webhook (use polling instead)
 */
export async function deleteWebhook(botToken: string): Promise<boolean> {
  const client = getTelegramClient(botToken);

  try {
    const response = await client.post('/deleteWebhook');
    return response.data?.ok || false;
  } catch (error) {
    handleTelegramError(error, 'deleteWebhook');
    return false;
  }
}

// ============================================================================
// SENDING MESSAGES
// ============================================================================

/**
 * Send chat action (typing indicator)
 */
export async function sendChatAction(
  botToken: string,
  chatId: number | string,
  action: 'typing' | 'upload_photo' | 'upload_video' | 'upload_document'
): Promise<void> {
  const client = getTelegramClient(botToken);

  try {
    await retryOnTimeout(() =>
      client.post('/sendChatAction', {
        chat_id: chatId,
        action
      })
    );
    logger.debug({ chatId, action }, 'Telegram: Sent chat action');
  } catch (error) {
    // Don't throw - chat actions are nice-to-have
    logger.debug({ chatId, action }, 'Failed to send chat action');
  }
}

/**
 * Send text message
 */
export async function sendTextMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  options?: {
    replyToMessageId?: number;
    disableNotification?: boolean;
    parseMode?: 'Markdown' | 'HTML';
  }
): Promise<void> {
  if (!text || text.trim().length === 0) {
    throw new Error('Message text cannot be empty');
  }

  const client = getTelegramClient(botToken);

  // Split long messages
  const chunks = splitLongText(text, MAX_MESSAGE_LENGTH);

  try {
    for (let i = 0; i < chunks.length; i++) {
      await retryOnTimeout(() =>
        client.post('/sendMessage', {
          chat_id: chatId,
          text: chunks[i],
          parse_mode: options?.parseMode,
          reply_to_message_id: options?.replyToMessageId,
          disable_notification: options?.disableNotification || false
        })
      );

      // Small delay between chunks to prevent rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    logger.info(
      { chatId, chunks: chunks.length, length: text.length },
      'Telegram: Text message sent'
    );
  } catch (error) {
    handleTelegramError(error, 'sendTextMessage');
    throw error;
  }
}

/**
 * Send photo with caption
 */
export async function sendPhoto(
  botToken: string,
  chatId: number | string,
  photoUrl: string,
  caption?: string
): Promise<void> {
  const client = getTelegramClient(botToken);

  try {
    await retryOnTimeout(() =>
      client.post('/sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption?.slice(0, MAX_CAPTION_LENGTH)
      })
    );

    logger.info({ chatId, photoUrl: photoUrl.slice(0, 80) }, 'Telegram: Photo sent');
  } catch (error) {
    handleTelegramError(error, 'sendPhoto');
    throw error;
  }
}

// ============================================================================
// PRODUCT CAROUSEL (INLINE KEYBOARD)
// ============================================================================

/**
 * Send product carousel as inline keyboard with product cards
 * 
 * Telegram doesn't have a native carousel like Facebook,
 * so we send multiple messages with inline keyboards
 */
export async function sendProductCarousel(
  botToken: string,
  chatId: number | string,
  products: RetrievedProduct[]
): Promise<void> {
  if (!products || products.length === 0) {
    return;
  }

  logger.info(
    {
      chatId,
      productCount: products.length,
      products: products.map(p => ({ id: p.id, name: p.name, price: p.price }))
    },
    'Telegram: Sending product carousel'
  );

  const client = getTelegramClient(botToken);
  const productsToShow = products.slice(0, MAX_PRODUCTS_IN_CAROUSEL);

  try {
    // Send each product as a separate message with photo and inline keyboard
    for (let i = 0; i < productsToShow.length; i++) {
      const product = productsToShow[i];
      if (!product) continue;

      // Build product description
      const description = [
        `🏷️ *${product.name}*`,
        product.description ? `\n${product.description.slice(0, 200)}` : '',
        product.category ? `\n📂 Category: ${product.category}` : '',
        product.size ? `\n📏 Size: ${product.size}` : '',
        product.price ? `\n💰 Price: $${product.price.toFixed(2)}` : ''
      ]
        .filter(Boolean)
        .join('');

      // Build inline keyboard buttons
      const inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];

      // Add "Buy" button if price exists
      if (product.price != null) {
        inlineKeyboard.push([
          {
            text: `💳 Buy for $${product.price.toFixed(2)}`,
            callback_data: `buy_${product.id}`
          }
        ]);
      }

      // Add "More Info" button
      inlineKeyboard.push([
        {
          text: '📖 More Info',
          callback_data: `info_${product.id}`
        }
      ]);

      // Send with photo if available
      if (product.image_url && typeof product.image_url === 'string') {
        const url = product.image_url.trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
          await retryOnTimeout(() =>
            client.post('/sendPhoto', {
              chat_id: chatId,
              photo: url,
              caption: description.slice(0, MAX_CAPTION_LENGTH),
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: inlineKeyboard
              }
            })
          );
        } else {
          // Send as text if image URL is invalid
          await retryOnTimeout(() =>
            client.post('/sendMessage', {
              chat_id: chatId,
              text: description,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: inlineKeyboard
              }
            })
          );
        }
      } else {
        // Send as text message if no image
        await retryOnTimeout(() =>
          client.post('/sendMessage', {
            chat_id: chatId,
            text: description,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: inlineKeyboard
            }
          })
        );
      }

      // Small delay between products to prevent rate limiting
      if (i < productsToShow.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    logger.info(
      { chatId, productsSent: productsToShow.length },
      '✅ Telegram: Product carousel sent'
    );
  } catch (error) {
    handleTelegramError(error, 'sendProductCarousel');
    throw error;
  }
}

/**
 * Answer callback query (from inline keyboard buttons)
 */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  options?: {
    text?: string;
    showAlert?: boolean;
    url?: string;
  }
): Promise<void> {
  const client = getTelegramClient(botToken);

  try {
    await client.post('/answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: options?.text,
      show_alert: options?.showAlert || false,
      url: options?.url
    });
  } catch (error) {
    handleTelegramError(error, 'answerCallbackQuery');
  }
}

// ============================================================================
// WEBHOOK VALIDATION
// ============================================================================

/**
 * Validate Telegram webhook request
 * Telegram doesn't use HMAC signatures like Facebook,
 * but you should validate the secret token you set
 */
export function isValidTelegramRequest(
  secretToken: string,
  providedToken: string | undefined
): boolean {
  if (!providedToken || !secretToken) {
    return false;
  }

  // Use timing-safe comparison
  if (providedToken.length !== secretToken.length) {
    return false;
  }

  return providedToken === secretToken;
}

/**
 * Extract message data from Telegram update
 */
export function extractTelegramMessage(update: TelegramUpdate): {
  chatId: number;
  userId: number;
  messageText: string;
  messageId?: number;
  username?: string;
  firstName?: string;
  photo?: string;
  hasPhoto: boolean;
} | null {
  const message = update.message || update.edited_message;

  if (!message) {
    return null;
  }

  // Extract photo URL if available (get largest photo)
  let photoFileId: string | undefined;
  if (message.photo && message.photo.length > 0) {
    // Get the largest photo
    const largestPhoto = message.photo.reduce((prev, current) =>
      current.file_size && prev.file_size && current.file_size > prev.file_size ? current : prev
    );
    photoFileId = largestPhoto.file_id;
  }

  const result: {
    chatId: number;
    userId: number;
    messageText: string;
    messageId?: number;
    username?: string;
    firstName?: string;
    photo?: string;
    hasPhoto: boolean;
  } = {
    chatId: message.chat.id,
    userId: message.from.id,
    messageText: message.text || message.caption || '',
    hasPhoto: !!photoFileId
  };

  if (message.message_id) result.messageId = message.message_id;
  if (message.from.username) result.username = message.from.username;
  if (message.from.first_name) result.firstName = message.from.first_name;
  if (photoFileId) result.photo = photoFileId;

  return result;
}

/**
 * Get file URL from file_id
 */
export async function getFileUrl(
  botToken: string,
  fileId: string
): Promise<string | null> {
  const client = getTelegramClient(botToken);

  try {
    const response = await client.post('/getFile', {
      file_id: fileId
    });

    if (response.data?.ok && response.data?.result?.file_path) {
      const filePath = response.data.result.file_path;
      return `${TELEGRAM_API_BASE_URL}/file/bot${botToken}/${filePath}`;
    }

    return null;
  } catch (error) {
    handleTelegramError(error, 'getFile');
    return null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get bot info
 */
export async function getMe(botToken: string): Promise<any> {
  const client = getTelegramClient(botToken);

  try {
    const response = await client.get('/getMe');
    return response.data?.result;
  } catch (error) {
    handleTelegramError(error, 'getMe');
    return null;
  }
}

/**
 * Send message with retry and error handling
 * Convenience wrapper for common use case
 */
export async function sendMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  products?: RetrievedProduct[]
): Promise<void> {
  // Send typing indicator
  await sendChatAction(botToken, chatId, 'typing').catch(() => {});

  // Send product carousel if available
  if (products && products.length > 0) {
    await sendProductCarousel(botToken, chatId, products);
  }

  // Send text message
  await sendTextMessage(botToken, chatId, text);
}

