/**
 * Telegram Bot with Long Polling
 * 
 * This allows you to run the bot locally without ngrok!
 * Unlike Facebook Messenger, Telegram supports polling mode.
 */

import dotenv from 'dotenv';
dotenv.config();

import * as telegram from './social/telegram';
import { handleConversation } from './core/conversation';
import { logger } from './core/logger';
import { RateLimiter } from './security/rate-limiter';
import { RATE_LIMIT_MAX_EVENTS, RATE_LIMIT_WINDOW_MS } from './security/constants';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLLING_INTERVAL = 2000; // Check every 2 seconds

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

// Rate limiter
const rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_EVENTS);

// Track last update ID to avoid processing duplicates
let lastUpdateId = 0;

/**
 * Get updates from Telegram using long polling
 */
async function getUpdates(): Promise<telegram.TelegramUpdate[]> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(35000) // 35s timeout (5s more than Telegram's 30s)
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as any;

    if (!data.ok) {
      throw new Error(data.description || 'Failed to get updates');
    }

    return data.result || [];

  } catch (error: any) {
    if (error.name === 'AbortError') {
      logger.warn('Telegram polling timeout - retrying');
    } else {
      logger.error({ error: error.message }, 'Error getting Telegram updates');
    }
    return [];
  }
}

/**
 * Process a single message
 */
async function processMessage(messageData: ReturnType<typeof telegram.extractTelegramMessage>) {
  if (!messageData) return;

  const { chatId, userId, messageText, messageId, photo, hasPhoto } = messageData;

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
      BOT_TOKEN!,
      chatId,
      'Please slow down! You\'re sending messages too quickly. ⏱️'
    );
    return;
  }

  try {
    // Send typing indicator
    await telegram.sendChatAction(BOT_TOKEN!, chatId, 'typing');

    // Get photo URL if available
    let imageUrl: string | undefined;
    if (photo) {
      const fileUrl = await telegram.getFileUrl(BOT_TOKEN!, photo);
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
      BOT_TOKEN!,
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
      BOT_TOKEN!,
      chatId,
      'Sorry, there was an error processing your message. Please try again. 🔧'
    ).catch(() => {});
  }
}

/**
 * Process callback queries (button presses)
 */
async function processCallbackQuery(callbackQuery: any) {
  const { id, data, from, message } = callbackQuery;

  logger.info(
    {
      userId: from.id,
      data
    },
    '🔘 Telegram: Callback query received'
  );

  try {
    // Answer the callback to remove loading state
    await telegram.answerCallbackQuery(BOT_TOKEN!, id, {
      text: 'Processing your request...'
    });

    // Handle different callback data
    if (data?.startsWith('buy_')) {
      const productId = data.replace('buy_', '');
      logger.info({ userId: from.id, productId }, '🛒 User wants to buy product');
      
      // Send message about purchase process
      if (message) {
        await telegram.sendTextMessage(
          BOT_TOKEN!,
          message.chat.id,
          `Great! I'll help you order this product. Let me get your details.`
        );
        
        // Trigger conversation flow for ordering
        await handleConversation(
          String(from.id),
          `I want to buy this product`,
          {}
        );
      }
    } else if (data?.startsWith('info_')) {
      const productId = data.replace('info_', '');
      logger.info({ userId: from.id, productId }, 'ℹ️ User wants more info');
      
      if (message) {
        await telegram.sendTextMessage(
          BOT_TOKEN!,
          message.chat.id,
          `Let me give you more information about this product...`
        );
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message }, 'Error processing callback query');
  }
}

/**
 * Main polling loop
 */
async function startPolling() {
  // First, delete any existing webhook
  try {
    await telegram.deleteWebhook(BOT_TOKEN!);
    logger.info('✅ Deleted existing webhook (if any)');
  } catch (error) {
    logger.warn('Could not delete webhook - continuing anyway');
  }

  // Get bot info
  const botInfo = await telegram.getMe(BOT_TOKEN!);
  
  console.log('\n🤖 Telegram Bot Started (Polling Mode)\n');
  console.log(`Bot: @${botInfo.username}`);
  console.log(`Name: ${botInfo.first_name}`);
  console.log(`ID: ${botInfo.id}`);
  console.log('\n✅ Ready! Send a message to your bot on Telegram\n');
  console.log('💡 This runs locally - no ngrok needed!\n');
  console.log('Press Ctrl+C to stop\n');

  logger.info({ username: botInfo.username }, '🚀 Telegram polling started');

  // Start polling loop
  while (true) {
    try {
      const updates = await getUpdates();

      if (updates.length > 0) {
        logger.debug({ count: updates.length }, 'Received updates');

        for (const update of updates) {
          // Update last processed ID
          if (update.update_id > lastUpdateId) {
            lastUpdateId = update.update_id;
          }

          // Process message
          if (update.message || update.edited_message) {
            const messageData = telegram.extractTelegramMessage(update);
            await processMessage(messageData);
          }

          // Process callback query
          if (update.callback_query) {
            await processCallbackQuery(update.callback_query);
          }
        }
      }

      // Small delay before next poll
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));

    } catch (error: any) {
      logger.error({ error: error.message }, 'Error in polling loop');
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down Telegram bot...');
  logger.info('Telegram bot stopped');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Shutting down Telegram bot...');
  logger.info('Telegram bot stopped');
  process.exit(0);
});

// Start the bot
startPolling().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

