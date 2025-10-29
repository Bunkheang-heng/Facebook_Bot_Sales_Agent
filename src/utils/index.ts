/**
 * Shared utilities for the Messenger Bot application
 * 
 * This module exports reusable utilities that prevent code duplication
 * across the codebase.
 */

// Security utilities (re-exported from security/)
export { RateLimiter } from '../security/rate-limiter';
export { 
  verifyWebhookSignature, 
  verifyWebhookChallenge, 
  extractMessagingEvents,
  type MessagingEvent 
} from '../security/webhook';
export { ReplayCache } from '../security/replay-cache';
export { 
  conversationStageSchema, 
  leadUpdateSchema, 
  userMessageSchema, 
  maskEmail, 
  maskPhone, 
  buildLeadUpdate 
} from '../security/validators';

// Text utilities (stay in utils/)
export { clampText, sanitizeContent, hasContent } from './text';

// Language utilities (stay in utils/)
export {
  detectLanguage,
  getPreferredLanguage,
} from './language';

// Product/AI utilities (re-exported from lib/)
export { 
  filterProductsForDisplay, 
  shouldDisplayProducts,
  PRODUCT_DISPLAY_CONFIG 
} from '../lib/products';
export {
  getProductsForCarousel,
  shouldShowCarousel,
  extractMentionedProducts
} from '../lib/ai-product-matcher';

// Social utilities (re-exported from social/)
export {
  downloadImageAsBase64,
  isValidImageUrl,
  getImageContentType
} from '../social/image';
export { EventBuffer } from '../social/event-buffer';

// Formatting utilities (re-exported from formatters/)
export {
  stripMarkdown,
  cleanAIResponse
} from '../formatters/formatting';
export { formatOrderSummary } from '../formatters/order-formatter';
