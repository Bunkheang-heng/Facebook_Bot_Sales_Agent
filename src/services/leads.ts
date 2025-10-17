import { db } from '../firebase';

export type ConversationStage = 'ask_item' | 'ask_name' | 'ask_phone' | 'ask_address' | 'completed';

export type LeadDoc = {
  userId: string;
  item?: string;
  name?: string;
  phone?: string;
  address?: string;
  stage: ConversationStage;
  updatedAt: number;
};

const COLLECTION = 'leads';

export async function getOrCreateLead(userId: string): Promise<LeadDoc> {
  const ref = db.collection(COLLECTION).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const lead: LeadDoc = { userId, stage: 'ask_item', updatedAt: Date.now() };
    await ref.set(lead);
    return lead;
  }
  const data = snap.data() as LeadDoc;
  return { ...data, stage: data.stage ?? 'ask_item' };
}

export async function updateLead(userId: string, partial: Partial<LeadDoc>): Promise<void> {
  const ref = db.collection(COLLECTION).doc(userId);
  await ref.set({ ...partial, updatedAt: Date.now() }, { merge: true });
}


