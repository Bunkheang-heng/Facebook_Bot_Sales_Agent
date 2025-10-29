import OpenAI from 'openai';
import { getSystemPrompt } from './prompts';
import { buildRagContext, retrieveSimilarContext } from '../services/rag';
import { getChatHistory, getConversationSummary, updateConversationSummary } from '../services/history-supabase';
import type { LeadDoc } from '../services/leads-supabase';
import { logger } from './logger';
import { clampText } from '../utils/text';
import { cleanAIResponse, detectLanguage } from '../utils';
import { RateLimiter } from '../security/rate-limiter';

// ====== SECURITY & PERFORMANCE ENHANCEMENTS ======

// Response cache with TTL (5 minutes)
type CacheEntry = { response: string; language: 'km' | 'en'; timestamp: number };
const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Request deduplication to prevent concurrent identical requests
const pendingRequests = new Map<string, Promise<{ reply: string; language: 'km' | 'en' }>>();

// Rate limiter for AI requests (4 requests per 30 seconds per user)
const aiRateLimiter = new RateLimiter(30_000, 4);

// Circuit breaker to prevent cascading failures
let circuitBreakerFailures = 0;
let circuitBreakerResetTime = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT = 60_000; // 1 minute

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing required env var: OPENAI_API_KEY');
    }
    // Validate API key format (should start with 'sk-')
    if (!apiKey.startsWith('sk-')) {
      logger.error('Invalid OpenAI API key format');
      throw new Error('Invalid OPENAI_API_KEY format');
    }
    // Reduced timeout for better UX (5 seconds instead of 8)
    openaiClient = new OpenAI({ apiKey, timeout: 5000, maxRetries: 2 });
  }
  return openaiClient;
}

/**
 * Sanitize user input to prevent prompt injection
 * Removes control characters and limits special character sequences
 */
function sanitizeInput(input: string): string {
  return input
    // Remove control characters except newlines and tabs
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    // Limit consecutive special characters to prevent injection
    .replace(/([^\w\s])\1{4,}/g, '$1$1$1')
    // Remove potential prompt injection patterns
    .replace(/\b(ignore|disregard|forget)\s+(previous|all|above)\s+(instructions|prompts?|rules?)/gi, '[filtered]')
    .trim();
}

/**
 * Sanitize lead data to prevent data leakage through prompts
 */
function sanitizeLeadData(lead: LeadDoc): { name?: string; phone?: string; address?: string; item?: string } {
  const sanitize = (text: string | null | undefined): string | undefined => {
    if (!text) return undefined;
    // Remove potential PII patterns and keep it simple
    return clampText(sanitizeInput(text), 100);
  };

  const result: { name?: string; phone?: string; address?: string; item?: string } = {};
  
  const sanitizedName = sanitize(lead.name);
  if (sanitizedName) result.name = sanitizedName;
  
  if (lead.phone) result.phone = `***${lead.phone.slice(-4)}`; // Mask phone
  
  const sanitizedAddress = sanitize(lead.address);
  if (sanitizedAddress) result.address = sanitizedAddress;
  
  const sanitizedItem = sanitize(lead.item);
  if (sanitizedItem) result.item = sanitizedItem;

  return result;
}

/**
 * Check circuit breaker status
 */
function isCircuitBreakerOpen(): boolean {
  const now = Date.now();
  if (circuitBreakerResetTime > now) {
    return true;
  }
  if (circuitBreakerResetTime > 0 && circuitBreakerResetTime <= now) {
    // Reset circuit breaker
    circuitBreakerFailures = 0;
    circuitBreakerResetTime = 0;
    logger.info('Circuit breaker reset');
  }
  return false;
}

/**
 * Record circuit breaker failure
 */
function recordCircuitBreakerFailure(): void {
  circuitBreakerFailures++;
  if (circuitBreakerFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakerResetTime = Date.now() + CIRCUIT_BREAKER_TIMEOUT;
    logger.error(
      { failures: circuitBreakerFailures, resetIn: CIRCUIT_BREAKER_TIMEOUT },
      '⚠️ Circuit breaker opened - OpenAI requests temporarily blocked'
    );
  }
}

/**
 * Clean cache entries older than TTL
 */
function cleanExpiredCache(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of responseCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      responseCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned }, 'Cleaned expired cache entries');
  }
}

// Auto-cleanup cache and rate limiter every minute
setInterval(() => {
  cleanExpiredCache();
  aiRateLimiter.cleanExpired();
}, 60_000);

export async function generateAiReply(userMessageText: string): Promise<{ reply: string; language: 'km' | 'en' }> {
  // ====== SECURITY: Input validation ======
  if (!userMessageText || userMessageText.trim().length === 0) {
    throw new Error('Empty message not allowed');
  }
  
  if (userMessageText.length > 5000) {
    throw new Error('Message too long');
  }

  // ====== SECURITY: Sanitize input ======
  const sanitized = sanitizeInput(userMessageText);
  const safeUser = clampText(sanitized, 800);
  const language = detectLanguage(userMessageText);

  // ====== PERFORMANCE: Check cache ======
  const cacheKey = `simple:${safeUser}:${language}`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug({ cacheKey }, '🎯 Cache hit for simple reply');
    return { reply: cached.response, language: cached.language };
  }

  // ====== SECURITY: Check circuit breaker ======
  if (isCircuitBreakerOpen()) {
    logger.warn('Circuit breaker is open, returning fallback');
    const fallback = language === 'km' 
      ? "សូមអភ័យទោស សេវាកម្មបច្ចុប្បន្នមិនអាចប្រើបានទេ។ សូមព្យាយាមម្តងទៀតក្នុងពេលបន្តិចទៀត។"
      : "Sorry, the service is temporarily unavailable. Please try again in a moment.";
    return { reply: fallback, language };
  }

  // ====== PERFORMANCE: Request deduplication ======
  const existingRequest = pendingRequests.get(cacheKey);
  if (existingRequest) {
    logger.debug({ cacheKey }, '⏳ Deduplicating concurrent request');
    return existingRequest;
  }

  // Create new request
  const requestPromise = (async () => {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_completion_tokens: 300,
        messages: [
          { role: 'system', content: getSystemPrompt(language) },
          { role: 'user', content: safeUser }
        ]
      });

      // ====== LOG TOKEN USAGE ======
      const tokenUsage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
      };

      const content = completion.choices?.[0]?.message?.content?.trim();
      
      // ====== SECURITY: Validate output ======
      if (!content || content.length === 0) {
        logger.warn({ tokenUsage }, 'Empty response from OpenAI');
        const fallback = language === 'km' 
          ? "ខ្ញុំត្រៀមខ្លួនរួចហើយដើម្បីជួយអ្នក! តើអ្នកអាចសួរម្តងទៀតបានទេ?"
          : "I'm here and ready to help! Could you rephrase your question?";
        return { reply: fallback, language };
      }
      
      // Clean markdown formatting that Messenger doesn't support
      const cleaned = cleanAIResponse(content);
      const finalReply = clampText(cleaned, 800);

      // ====== PERFORMANCE: Cache the response ======
      responseCache.set(cacheKey, {
        response: finalReply,
        language,
        timestamp: Date.now()
      });

      // Reset circuit breaker on success
      if (circuitBreakerFailures > 0) {
        circuitBreakerFailures = Math.max(0, circuitBreakerFailures - 1);
      }

      // ====== LOG SUCCESSFUL GENERATION WITH TOKEN USAGE ======
      logger.info(
        {
          language,
          responseLength: finalReply.length,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          totalTokens: tokenUsage.totalTokens,
          model: 'gpt-4o-mini'
        },
        '✅ AI: Simple reply generated'
      );

      return { reply: finalReply, language };
    } catch (error) {
      // ====== SECURITY: Safe error handling ======
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, '❌ OpenAI API error');
      recordCircuitBreakerFailure();
      
      const fallback = language === 'km' 
        ? "សូមអភ័យទោស មានបញ្ហាបច្ចេកទេស។ សូមព្យាយាមម្តងទៀត។"
        : "Sorry, there was a technical issue. Please try again.";
      return { reply: fallback, language };
    } finally {
      // Clean up pending request
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// History-aware generation with lead-context injection
export async function generateAiReplyWithHistory(
  userId: string,
  userMessageText: string,
  lead?: LeadDoc,
  preRetrievedProducts?: any[] // Avoid duplicate RAG calls
): Promise<{ reply: string; language: 'km' | 'en' }> {
  // ====== SECURITY: Input validation ======
  if (!userId || !userMessageText || userMessageText.trim().length === 0) {
    throw new Error('Invalid userId or empty message');
  }
  
  if (userMessageText.length > 5000) {
    throw new Error('Message too long');
  }

  // ====== SECURITY: Rate limiting ======
  if (!aiRateLimiter.allowEvent(userId)) {
    logger.warn({ userId }, '⚠️ Rate limit exceeded');
    aiRateLimiter.recordAnomaly(userId);
    const language = detectLanguage(userMessageText);
    const fallback = language === 'km'
      ? "សូមអភ័យទោស អ្នកបានផ្ញើសារច្រើនពេក។ សូមរង់ចាំបន្តិច។"
      : "Sorry, you're sending messages too quickly. Please wait a moment.";
    return { reply: fallback, language };
  }

  // ====== SECURITY: Sanitize input ======
  const sanitized = sanitizeInput(userMessageText);
  const safeUser = clampText(sanitized, 800);

  logger.info({ userId, query: safeUser.slice(0, 100) }, '🤖 AI: Starting context-aware reply generation');

  // Detect language from current message (prioritize current over history)
  const language = detectLanguage(userMessageText);

  // ====== SECURITY: Check circuit breaker ======
  if (isCircuitBreakerOpen()) {
    logger.warn('Circuit breaker is open, returning fallback');
    const fallback = language === 'km'
      ? "សូមអភ័យទោស សេវាកម្មបច្ចុប្បន្នមិនអាចប្រើបានទេ។ សូមព្យាយាមម្តងទៀតក្នុងពេលបន្តិចទៀត។"
      : "Sorry, the service is temporarily unavailable. Please try again in a moment.";
    return { reply: fallback, language };
  }

  // ====== PERFORMANCE: Cache key for context-aware replies ======
  // Include userId, message, and lead status in cache key
  const cacheKey = `history:${userId}:${safeUser.slice(0, 50)}:${!!lead}`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug({ userId, cacheKey }, '🎯 Cache hit for history-aware reply');
    return { reply: cached.response, language: cached.language };
  }

  // ====== PERFORMANCE: Request deduplication ======
  const existingRequest = pendingRequests.get(cacheKey);
  if (existingRequest) {
    logger.debug({ userId, cacheKey }, '⏳ Deduplicating concurrent request');
    return existingRequest;
  }

  const requestPromise = (async () => {
    try {
      // ====== PERFORMANCE: Parallel data fetching ======
      const [recent, summary, retrieved] = await Promise.all([
        getChatHistory(userId, 8),
        getConversationSummary(userId),
        preRetrievedProducts ? Promise.resolve(preRetrievedProducts) : retrieveSimilarContext(safeUser).catch(() => [])
      ]);

      // ====== SECURITY: Sanitize lead data ======
      const sanitizedLead = lead ? sanitizeLeadData(lead) : null;
      const leadFacts = sanitizedLead
        ? [
            sanitizedLead.name ? `Name: ${sanitizedLead.name}` : null,
            sanitizedLead.phone ? `Phone: ${sanitizedLead.phone}` : null,
            sanitizedLead.address ? `Address: ${sanitizedLead.address}` : null,
            sanitizedLead.item ? `Interested Item: ${sanitizedLead.item}` : null
          ]
            .filter(Boolean)
            .join('\n')
        : '';

      const ragBlock = buildRagContext(retrieved as any);
      const contextPreamble = [
        getSystemPrompt(language),  // Language-aware system prompt
        leadFacts ? `Known customer details:\n${leadFacts}` : null,
        summary ? `Conversation summary:\n${clampText(sanitizeInput(summary), 500)}` : null,
        ragBlock ? ragBlock : null
      ]
        .filter(Boolean)
        .join('\n\n');

      // ====== SECURITY: Sanitize history messages ======
      const historyMessages = recent.reverse().map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: clampText(sanitizeInput(m.content), 800)
      }));

      logger.info(
        {
          userId,
          historyCount: historyMessages.length,
          hasSummary: !!summary,
          hasLeadFacts: !!leadFacts,
          retrievedProducts: retrieved.length,
          contextLength: contextPreamble.length
        },
        '📝 AI: Context assembled'
      );

      const completion = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_completion_tokens: 300, // Use max_completion_tokens consistently
        messages: [
          { role: 'system', content: contextPreamble },
          ...historyMessages,
          { role: 'user', content: safeUser }
        ]
      });

      // ====== LOG TOKEN USAGE ======
      const tokenUsage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
      };

      const content = completion.choices?.[0]?.message?.content?.trim();
      
      // ====== SECURITY: Validate output ======
      if (!content || content.length === 0) {
        logger.warn({ userId, tokenUsage }, 'Empty response from OpenAI');
        const fallback = language === 'km'
          ? "ពិតណាស់ — តើខ្ញុំអាចជួយអ្វីបានទៀត?"
          : 'Sure—how can I help further?';
        return { reply: fallback, language };
      }
      
      // Clean markdown formatting that Messenger doesn't support
      const cleaned = cleanAIResponse(content);
      const finalReply = clampText(cleaned, 800);

      // ====== PERFORMANCE: Cache the response ======
      responseCache.set(cacheKey, {
        response: finalReply,
        language,
        timestamp: Date.now()
      });

      // Reset circuit breaker on success
      if (circuitBreakerFailures > 0) {
        circuitBreakerFailures = Math.max(0, circuitBreakerFailures - 1);
      }
      
      // ====== LOG SUCCESSFUL GENERATION WITH DETAILED TOKEN USAGE ======
      logger.info(
        {
          userId,
          language,
          responseLength: finalReply.length,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          totalTokens: tokenUsage.totalTokens,
          model: 'gpt-4o-mini',
          historyCount: historyMessages.length,
          contextSize: contextPreamble.length,
          retrievedProducts: retrieved.length
        },
        '✅ AI: History-aware reply generated'
      );

      return { reply: finalReply, language };
    } catch (error) {
      // ====== SECURITY: Safe error handling ======
      logger.error({ 
        userId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, '❌ OpenAI API error in history-aware generation');
      recordCircuitBreakerFailure();
      
      const fallback = language === 'km'
        ? "សូមអភ័យទោស មានបញ្ហាបច្ចេកទេស។ សូមព្យាយាមម្តងទៀត។"
        : "Sorry, there was a technical issue. Please try again.";
      return { reply: fallback, language };
    } finally {
      // Clean up pending request
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// Optional: summarize long threads to reduce tokens
export async function refreshThreadSummary(userId: string): Promise<void> {
  // ====== SECURITY: Input validation ======
  if (!userId || userId.trim().length === 0) {
    logger.warn('Invalid userId for thread summary');
    return;
  }

  // ====== SECURITY: Check circuit breaker ======
  if (isCircuitBreakerOpen()) {
    logger.warn('Circuit breaker is open, skipping summary generation');
    return;
  }

  try {
    const recent = await getChatHistory(userId, 50);
    if (recent.length < 20) return; // summarize only when long enough
    
    // ====== SECURITY: Sanitize conversation history ======
    const text = recent
      .reverse() // Reverse to chronological order
      .map((t) => `${t.role.toUpperCase()}: ${sanitizeInput(t.content)}`)
      .join('\n')
      .slice(0, 6000);

    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_completion_tokens: 250, // Use max_completion_tokens consistently
      messages: [
        {
          role: 'system',
          content:
            'Summarize the conversation into concise bullet points with key facts and requests. Omit small talk. Do not include any PII like phone numbers or emails in full.'
        },
        { role: 'user', content: text }
      ]
    });
    
    // ====== LOG TOKEN USAGE ======
    const tokenUsage = {
      promptTokens: completion.usage?.prompt_tokens || 0,
      completionTokens: completion.usage?.completion_tokens || 0,
      totalTokens: completion.usage?.total_tokens || 0
    };
    
    const summary = completion.choices?.[0]?.message?.content?.trim();
    
    // ====== SECURITY: Validate and sanitize output ======
    if (summary && summary.length > 0) {
      const sanitizedSummary = clampText(sanitizeInput(summary), 1000);
      await updateConversationSummary(userId, sanitizedSummary, recent.length);
      
      logger.info(
        { 
          userId, 
          summaryLength: sanitizedSummary.length,
          messagesProcessed: recent.length,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
          totalTokens: tokenUsage.totalTokens,
          model: 'gpt-4o-mini'
        }, 
        '✅ Thread summary updated'
      );
      
      // Reset circuit breaker on success
      if (circuitBreakerFailures > 0) {
        circuitBreakerFailures = Math.max(0, circuitBreakerFailures - 1);
      }
    } else {
      logger.warn({ userId, tokenUsage }, 'Empty summary generated');
    }
  } catch (error) {
    // ====== SECURITY: Safe error handling ======
    logger.error({ 
      userId, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, '❌ Failed to generate thread summary');
    recordCircuitBreakerFailure();
  }
}