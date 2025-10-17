import OpenAI from 'openai';
import { db } from './firebase';
import { systemPrompt } from './prompts';

type ConversationStage = 'ask_item' | 'ask_name' | 'ask_phone' | 'ask_address' | 'completed';

type LeadDoc = {
  userId: string;
  item?: string;
  name?: string;
  phone?: string;
  address?: string;
  stage: ConversationStage;
  updatedAt: number;
};

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing required env var: OPENAI_API_KEY');
    }
    openaiClient = new OpenAI({ apiKey, timeout: 10000, maxRetries: 2 });
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

export async function handleConversation(userId: string, userMessageText: string): Promise<string> {
  const leads = db.collection('leads');
  const ref = leads.doc(userId);
  const snap = await ref.get();
  let lead: LeadDoc;
  if (!snap.exists) {
    lead = {
      userId,
      stage: 'ask_item',
      updatedAt: Date.now()
    };
    await ref.set(lead);
  } else {
    lead = snap.data() as LeadDoc;
    if (!lead.stage) lead.stage = 'ask_item';
  }

  const msg = userMessageText.trim();

  if (lead.stage === 'ask_item') {
    lead.item = msg;
    lead.stage = 'ask_name';
    lead.updatedAt = Date.now();
    await ref.set(lead, { merge: true });
    return 'Great! May I have your full name?';
  }

  if (lead.stage === 'ask_name') {
    lead.name = msg;
    lead.stage = 'ask_phone';
    lead.updatedAt = Date.now();
    await ref.set(lead, { merge: true });
    return 'Thanks! What is the best phone number to reach you?';
  }

  if (lead.stage === 'ask_phone') {
    // Basic normalization; accept any input and store
    lead.phone = msg;
    lead.stage = 'ask_address';
    lead.updatedAt = Date.now();
    await ref.set(lead, { merge: true });
    return 'Got it. Finally, could you provide your delivery address?';
  }

  if (lead.stage === 'ask_address') {
    lead.address = msg;
    lead.stage = 'completed';
    lead.updatedAt = Date.now();
    await ref.set(lead, { merge: true });
    return 'Thank you! Your details have been saved. Our sales team will contact you shortly.';
  }

  // If conversation is completed, fall back to AI small talk or confirmation.
  return 'We have your details on file. How else can I help today?';
}


