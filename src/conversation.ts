import { prompts } from './prompts';
import { getOrCreateLead, updateLead } from './services/leads';
import { saveAssistantMessage, saveUserMessage } from './services/history';
import { generateAiReplyWithHistory, refreshThreadSummary } from './ai';
import { normalizePhone } from './services/phone';

export async function handleConversation(userId: string, userMessageText: string, opts?: { mid?: string }): Promise<string> {
  const msg = userMessageText.trim();
  const leadPromise = getOrCreateLead(userId);
  const saveUserPromise = saveUserMessage(userId, msg, opts?.mid);
  const lead = await leadPromise;
  await saveUserPromise;

  if (lead.stage === 'ask_item') {
    await updateLead(userId, { item: msg, stage: 'ask_name' });
    await saveAssistantMessage(userId, prompts.askName);
    return prompts.askName;
  }
  if (lead.stage === 'ask_name') {
    await updateLead(userId, { name: msg, stage: 'ask_phone' });
    await saveAssistantMessage(userId, prompts.askPhone);
    return prompts.askPhone;
  }
  if (lead.stage === 'ask_phone') {
    const norm = normalizePhone(msg, 'KH');
    await updateLead(userId, { phone: norm.e164 ?? msg, stage: 'ask_address' });
    await saveAssistantMessage(userId, prompts.askAddress);
    return prompts.askAddress;
  }
  if (lead.stage === 'ask_address') {
    await updateLead(userId, { address: msg, stage: 'completed' });
    await saveAssistantMessage(userId, prompts.done);
    return prompts.done;
  }
  const reply = await generateAiReplyWithHistory(userId, msg, lead);
  // Non-blocking persistence
  saveAssistantMessage(userId, reply).catch(() => {});
  if (Math.random() < 0.1) refreshThreadSummary(userId).catch(() => {});
  return reply;
}


