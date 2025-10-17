import OpenAI from 'openai';
import { systemPrompt } from './prompts';
import { getRecentMessages, getSummary, setSummary } from './services/history';
import type { LeadDoc } from './services/leads';

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

function clampInput(input: string, maxChars = 800): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '…';
}

export async function generateAiReply(userMessageText: string): Promise<string> {
  const safeUser = clampInput(userMessageText);

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
  return clampInput(response, 800);
}

// History-aware generation with lead-context injection
export async function generateAiReplyWithHistory(
  userId: string,
  userMessageText: string,
  lead?: LeadDoc
): Promise<string> {
  const recent = await getRecentMessages(userId, 8);
  const summary = await getSummary(userId);

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

  const contextPreamble = [
    systemPrompt,
    leadFacts ? `Known customer details:\n${leadFacts}` : null,
    summary ? `Conversation summary:\n${summary}` : null
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyMessages = recent.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: clampInput(m.content)
  }));

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 300,
    messages: [
      { role: 'system', content: contextPreamble },
      ...historyMessages,
      { role: 'user', content: clampInput(userMessageText) }
    ]
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  const response = content && content.length > 0 ? content : 'Sure—how can I help further?';
  return clampInput(response, 800);
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

