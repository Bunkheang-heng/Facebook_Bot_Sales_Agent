import { db } from '../firebase';
import { Timestamp } from 'firebase-admin/firestore';

type Role = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  role: Role;
  content: string;
  ts: number; // milliseconds, for in-app use
};

const THREADS = 'threads';

function clampContent(input: string, max = 1000): string {
  const t = input.trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

export async function saveMessage(userId: string, msg: { role: Role; content: string; ts?: number }, id?: string) {
  const content = clampContent(msg.content);
  const ref = id
    ? db.collection(THREADS).doc(userId).collection('messages').doc(id)
    : db.collection(THREADS).doc(userId).collection('messages').doc();
  await ref.set({ role: msg.role, content, ts: Timestamp.now() });
}

export async function saveUserMessage(userId: string, content: string, id?: string) {
  return saveMessage(userId, { role: 'user', content }, id);
}

export async function saveAssistantMessage(userId: string, content: string) {
  return saveMessage(userId, { role: 'assistant', content });
}

export async function getRecentMessages(userId: string, limit = 10): Promise<ChatMessage[]> {
  const ref = db
    .collection(THREADS)
    .doc(userId)
    .collection('messages')
    .orderBy('ts', 'desc')
    .limit(limit);
  const snap = await ref.get();
  const items = snap.docs.map((d) => {
    const data = d.data() as { role: Role; content: string; ts?: any };
    const rawTs = data.ts;
    let tsMs: number;
    if (rawTs && typeof rawTs.toMillis === 'function') {
      tsMs = rawTs.toMillis();
    } else if (typeof rawTs === 'number') {
      tsMs = rawTs;
    } else if (rawTs && typeof rawTs.seconds === 'number') {
      tsMs = Math.floor(rawTs.seconds * 1000);
    } else {
      tsMs = Date.now();
    }
    return { role: data.role, content: data.content, ts: tsMs } as ChatMessage;
  });
  return items.reverse();
}

export async function getSummary(userId: string): Promise<string | null> {
  const ref = db.collection(THREADS).doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as any;
  return (data?.summary as string) ?? null;
}

export async function setSummary(userId: string, summary: string): Promise<void> {
  const ref = db.collection(THREADS).doc(userId);
  await ref.set({ summary, summaryUpdatedAt: Timestamp.now() }, { merge: true });
}

// Retention: keep the latest `keep` messages; delete older in batches
export async function pruneOldMessages(userId: string, keep = 500, batchSize = 200): Promise<number> {
  // Find threshold ts = oldest ts among the latest `keep` messages
  const latestSnap = await db
    .collection(THREADS)
    .doc(userId)
    .collection('messages')
    .orderBy('ts', 'desc')
    .limit(keep)
    .get();

  if (latestSnap.empty) return 0;
  const docsDesc = latestSnap.docs;
  const lastData = docsDesc[docsDesc.length - 1]?.data() as { ts?: Timestamp } | undefined;
  const thresholdTs = lastData?.ts;
  if (!thresholdTs) return 0;

  let deleted = 0;
  while (true) {
    const oldSnap = await db
      .collection(THREADS)
      .doc(userId)
      .collection('messages')
      .where('ts', '<', thresholdTs)
      .orderBy('ts', 'asc')
      .limit(batchSize)
      .get();
    if (oldSnap.empty) break;
    const batch = db.batch();
    for (const d of oldSnap.docs) {
      batch.delete(d.ref);
    }
    await batch.commit();
    deleted += oldSnap.size;
    if (oldSnap.size < batchSize) break;
  }
  return deleted;
}



