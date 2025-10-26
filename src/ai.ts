import OpenAI from 'openai';
import { getSystemPrompt } from './prompts';
import { buildRagContext, retrieveSimilarContext } from './services/rag';
import { getChatHistory, getConversationSummary, updateConversationSummary } from './services/history-supabase';
import type { LeadDoc } from './services/leads-supabase';
import { logger } from './logger';
import { clampText } from './utils/text';
import { cleanAIResponse, detectLanguage } from './utils';

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing required env var: OPENAI_API_KEY');
    }
    openaiClient = new OpenAI({ apiKey, timeout: 8000, maxRetries: 2 });
  }
  return openaiClient;
}

export async function generateAiReply(userMessageText: string): Promise<{ reply: string; language: 'km' | 'en' }> {
  const safeUser = clampText(userMessageText, 800);
  const language = detectLanguage(userMessageText);

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_completion_tokens: 300,
    messages: [
      { role: 'system', content: getSystemPrompt(language) },
      { role: 'user', content: safeUser }
    ]
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  // Clamp output as well to prevent excessive message size
  const fallback = language === 'km' 
    ? "ខ្ញុំត្រៀមខ្លួនរួចហើយដើម្បីជួយអ្នក! តើអ្នកអាចសួរម្តងទៀតបានទេ?"
    : "I'm here and ready to help! Could you rephrase your question?";
    
  const response = content && content.length > 0 ? content : fallback;
  
  // Clean markdown formatting that Messenger doesn't support
  const cleaned = cleanAIResponse(response);
  return { reply: clampText(cleaned, 800), language };
}

// History-aware generation with lead-context injection
export async function generateAiReplyWithHistory(
  userId: string,
  userMessageText: string,
  lead?: LeadDoc,
  preRetrievedProducts?: any[] // Avoid duplicate RAG calls
): Promise<{ reply: string; language: 'km' | 'en' }> {
  logger.info({ userId, query: userMessageText.slice(0, 100) }, '🤖 AI: Starting context-aware reply generation');

  const [recent, summary] = await Promise.all([
    getChatHistory(userId, 8),
    getConversationSummary(userId)
  ]);
  
  // Detect language from current message (prioritize current over history)
  const language = detectLanguage(userMessageText);
  
  // Use pre-retrieved products if available, otherwise fetch
  const retrieved = preRetrievedProducts ?? await retrieveSimilarContext(userMessageText).catch(() => []);

  const leadFacts = lead
    ? [
        lead.name ? `Name: ${lead.name}` : null,
        lead.phone ? `Phone: ${lead.phone}` : null,
        lead.address ? `Address: ${lead.address}` : null,
        lead.item ? `Interested Item: ${lead.item}` : null
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const ragBlock = buildRagContext(retrieved as any);
  const contextPreamble = [
    getSystemPrompt(language),  // Language-aware system prompt
    leadFacts ? `Known customer details:\n${leadFacts}` : null,
    summary ? `Conversation summary:\n${summary}` : null,
    ragBlock ? ragBlock : null
  ]
    .filter(Boolean)
    .join('\n\n');

  // Reverse to get chronological order (getChatHistory returns DESC)
  const historyMessages = recent.reverse().map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: clampText(m.content, 800)
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
    max_tokens: 300,
    messages: [
      { role: 'system', content: contextPreamble },
      ...historyMessages,
      { role: 'user', content: clampText(userMessageText, 800) }
    ]
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  const fallback = language === 'km' 
    ? "ពិតណាស់ — តើខ្ញុំអាចជួយអ្វីបានទៀត?"
    : 'Sure—how can I help further?';
  const response = content && content.length > 0 ? content : fallback;
  
  // Clean markdown formatting that Messenger doesn't support
  const cleaned = cleanAIResponse(response);
  
  logger.info(
    {
      userId,
      language,
      responseLength: cleaned.length,
      tokensUsed: completion.usage?.total_tokens
    },
    '✅ AI: Reply generated'
  );

  return { reply: clampText(cleaned, 800), language };
}

// Optional: summarize long threads to reduce tokens
export async function refreshThreadSummary(userId: string): Promise<void> {
  const recent = await getChatHistory(userId, 50);
  if (recent.length < 20) return; // summarize only when long enough
  const text = recent
    .reverse() // Reverse to chronological order
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n')
    .slice(0, 6000);

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 250,
    messages: [
      {
        role: 'system',
        content:
          'Summarize the conversation into concise bullet points with key facts and requests. Omit small talk.'
      },
      { role: 'user', content: text }
    ]
  });
  const summary = completion.choices?.[0]?.message?.content?.trim();
  if (summary) await updateConversationSummary(userId, summary, recent.length);
}

