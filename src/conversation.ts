import { prompts } from './prompts';
import { getOrCreateLead, updateLead } from './services/leads';

export async function handleConversation(userId: string, userMessageText: string): Promise<string> {
  const lead = await getOrCreateLead(userId);
  const msg = userMessageText.trim();

  if (lead.stage === 'ask_item') {
    await updateLead(userId, { item: msg, stage: 'ask_name' });
    return prompts.askName;
  }
  if (lead.stage === 'ask_name') {
    await updateLead(userId, { name: msg, stage: 'ask_phone' });
    return prompts.askPhone;
  }
  if (lead.stage === 'ask_phone') {
    await updateLead(userId, { phone: msg, stage: 'ask_address' });
    return prompts.askAddress;
  }
  if (lead.stage === 'ask_address') {
    await updateLead(userId, { address: msg, stage: 'completed' });
    return prompts.done;
  }
  return 'We have your details on file. How else can I help today?';
}


