/**
 * Shared utilities for the Messenger Bot application
 * 
 * This module exports reusable utilities that prevent code duplication
 * across the codebase.
 */

export { RateLimiter } from './rate-limiter';
export { 
  verifyWebhookSignature, 
  verifyWebhookChallenge, 
  extractMessagingEvents,
  type MessagingEvent 
} from './webhook';
export { clampText, sanitizeContent, hasContent } from './text';
export { 
  filterProductsForDisplay, 
  shouldDisplayProducts,
  PRODUCT_DISPLAY_CONFIG 
} from './products';
export {
  getProductsForCarousel,
  shouldShowCarousel,
  extractMentionedProducts
} from './ai-product-matcher';
export {
  downloadImageAsBase64,
  isValidImageUrl,
  getImageContentType
} from './image';
export {
  stripMarkdown,
  cleanAIResponse
} from './formatting';
export {
  detectLanguage,
  getPreferredLanguage,
} from './language';

export { conversationStageSchema, leadUpdateSchema, userMessageSchema, maskEmail, maskPhone, buildLeadUpdate } from './validators';
export { ReplayCache } from './replay-cache';

