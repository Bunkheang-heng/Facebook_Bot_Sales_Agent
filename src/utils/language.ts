import { Language } from "../types/domain";

/**
 * Language detection and bilingual support utilities
 */



/**
 * Detect language from user message
 * @param text User's message
 * @returns 'km' for Khmer, 'en' for English
 */
export function detectLanguage(text: string): Language {
  if (!text || text.trim().length === 0) {
    return 'en'; // Default to English
  }

  // Check for Khmer Unicode characters (Khmer script range: U+1780 to U+17FF)
  const khmerCharRegex = /[\u1780-\u17FF]/;
  
  // Check for common Romanized Khmer words/patterns
  const romanizedKhmerPatterns = [
    /\b(ban|mean|ot|te|min|na|tae|nih|nuh|som|jol|chit|cher|del|aoy)\b/i,
    /\b(khnhom|neak|bong|oun|pros|srey|kmeng)\b/i,
    /\b(tngai|yub|pel)\b/i
  ];

  // 1. If contains Khmer script → Khmer
  if (khmerCharRegex.test(text)) {
    return 'km';
  }

  // 2. If contains Romanized Khmer patterns → Khmer
  const hasRomanizedKhmer = romanizedKhmerPatterns.some(pattern => pattern.test(text));
  if (hasRomanizedKhmer) {
    return 'km';
  }

  // 3. Otherwise → English
  return 'en';
}

/**
 * Get preferred language from conversation history
 * Uses the most recent user message to determine language preference
 */
export function getPreferredLanguage(messages: Array<{ role: string; content: string }>): Language {
  // Find the most recent user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return detectLanguage(messages[i]!.content);
    }
  }
  
  return 'en'; // Default to English
}

