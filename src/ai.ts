import OpenAI from 'openai';
import { systemPrompt } from './prompts';
import { buildRagContext, retrieveSimilarContext } from './services/rag';
import { getRecentMessages, getSummary, setSummary } from './services/history';
import type { LeadDoc } from './services/leads';
import { logger } from './logger';
import { clampText } from './utils/text';
import { cleanAIResponse } from './utils/formatting';

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

export async function generateAiReply(userMessageText: string): Promise<string> {
  const safeUser = clampText(userMessageText, 800);

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 300,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: safeUser }
    ]
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  // Clamp output as well to prevent excessive message size
  const response = content && content.length > 0
    ? content
    : "I'm here and ready to help! Could you rephrase your question?";
  
  // Clean markdown formatting that Messenger doesn't support
  const cleaned = cleanAIResponse(response);
  return clampText(cleaned, 800);
}

// History-aware generation with lead-context injection
export async function generateAiReplyWithHistory(
  userId: string,
  userMessageText: string,
  lead?: LeadDoc,
  preRetrievedProducts?: any[] // Avoid duplicate RAG calls
): Promise<string> {
  logger.info({ userId, query: userMessageText.slice(0, 100) }, '🤖 AI: Starting context-aware reply generation');

  const [recent, summary] = await Promise.all([
    getRecentMessages(userId, 8),
    getSummary(userId)
  ]);
  
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
    systemPrompt,
    leadFacts ? `Known customer details:\n${leadFacts}` : null,
    summary ? `Conversation summary:\n${summary}` : null,
    ragBlock ? ragBlock : null
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyMessages = recent.map((m) => ({
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
  const response = content && content.length > 0 ? content : 'Sure—how can I help further?';
  
  // Clean markdown formatting that Messenger doesn't support
  const cleaned = cleanAIResponse(response);
  
  logger.info(
    {
      userId,
      responseLength: cleaned.length,
      tokensUsed: completion.usage?.total_tokens
    },
    '✅ AI: Reply generated'
  );

  return clampText(cleaned, 800);
}

// Optional: summarize long threads to reduce tokens
export async function refreshThreadSummary(userId: string): Promise<void> {
  const recent = await getRecentMessages(userId, 50);
  if (recent.length < 20) return; // summarize only when long enough
  const text = recent
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
  if (summary) await setSummary(userId, summary);
}

