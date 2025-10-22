import { prompts } from './prompts';
import { getOrCreateLead, updateLead } from './services/leads';
import { saveAssistantMessage, saveUserMessage } from './services/history';
import { generateAiReplyWithHistory, refreshThreadSummary } from './ai';
import { normalizePhone } from './services/phone';
import { retrieveSimilarContext, type RetrievedProduct } from './services/rag';
import { logger } from './logger';

export type ConversationResponse = { text: string; products?: RetrievedProduct[] };

export async function handleConversation(userId: string, userMessageText: string, opts?: { mid?: string }): Promise<ConversationResponse> {
  const msg = userMessageText.trim();
  const leadPromise = getOrCreateLead(userId);
  const saveUserPromise = saveUserMessage(userId, msg, opts?.mid);
  const lead = await leadPromise;
  await saveUserPromise;

  if (lead.stage === 'ask_item') {
    const lower = msg.toLowerCase();
    const looksLikeGreeting = /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|hola|bonjour|សួស្តី)[!.,\s]*$/i.test(lower) || msg.length < 2;
    if (looksLikeGreeting) {
      await saveAssistantMessage(userId, prompts.askItem);
      return { text: prompts.askItem };
    }

    await updateLead(userId, { item: msg, stage: 'ask_name' });
    let products: RetrievedProduct[] | undefined;
    try {
      logger.info({ userId, query: msg }, '🔍 RAG: Starting product search');
      const found = await retrieveSimilarContext(msg, { matchCount: 5, minSimilarity: 0 });
      if (found && found.length > 0) {
        products = found;
        logger.info(
          {
            userId,
            query: msg,
            matchCount: found.length,
            topMatch: found[0]?.name,
            topSimilarity: found[0]?.similarity,
            products: found.map((p) => ({ id: p.id, name: p.name, price: p.price, similarity: p.similarity }))
          },
          '✅ RAG: Products retrieved'
        );
      } else {
        logger.info({ userId, query: msg }, '⚠️ RAG: No products found');
      }
    } catch (err: any) {
      logger.error({ userId, query: msg, error: err.message }, '❌ RAG: Retrieval failed');
    }

    const reply = prompts.askName;
    await saveAssistantMessage(userId, reply);
    return products ? { text: reply, products } : { text: reply };
  }
  if (lead.stage === 'ask_name') {
    await updateLead(userId, { name: msg, stage: 'ask_phone' });
    await saveAssistantMessage(userId, prompts.askPhone);
    return { text: prompts.askPhone };
  }
  if (lead.stage === 'ask_phone') {
    const norm = normalizePhone(msg, 'KH');
    await updateLead(userId, { phone: norm.e164 ?? msg, stage: 'ask_address' });
    await saveAssistantMessage(userId, prompts.askAddress);
    return { text: prompts.askAddress };
  }
  if (lead.stage === 'ask_address') {
    await updateLead(userId, { address: msg, stage: 'completed' });
    await saveAssistantMessage(userId, prompts.done);
    return { text: prompts.done };
  }
  
  // General chat - check if user is asking about products
  let products: RetrievedProduct[] | undefined;
  const lowerMsg = msg.toLowerCase();
  const isProductQuery = /\b(product|shoe|sneaker|item|what.*have|show|looking for|buy|purchase|available)\b/i.test(lowerMsg);
  
  if (isProductQuery) {
    try {
      logger.info({ userId, query: msg }, '🔍 RAG: Product query detected in general chat');
      const found = await retrieveSimilarContext(msg, { matchCount: 5, minSimilarity: 0 });
      if (found && found.length > 0) {
        products = found;
        logger.info(
          {
            userId,
            matchCount: found.length,
            topMatch: found[0]?.name,
            products: found.map((p) => ({ id: p.id, name: p.name, price: p.price, similarity: p.similarity }))
          },
          '✅ RAG: Products retrieved for general chat'
        );
      }
    } catch (err: any) {
      logger.error({ userId, error: err.message }, '❌ RAG: Product retrieval failed in general chat');
    }
  }
  
  const reply = await generateAiReplyWithHistory(userId, msg, lead);
  // Non-blocking persistence
  saveAssistantMessage(userId, reply).catch(() => {});
  if (Math.random() < 0.1) refreshThreadSummary(userId).catch(() => {});
  return products ? { text: reply, products } : { text: reply };
}


