import { prompts, confirmOrderPrompt, orderConfirmedPrompt } from './prompts';
import { getOrCreateLead, updateLead } from './services/leads-supabase';
import { saveAssistantMessage, saveUserMessage } from './services/history-supabase';
import { generateAiReplyWithHistory, refreshThreadSummary } from './ai';
import { normalizePhone } from './services/phone';
import { retrieveSimilarContext, retrieveSimilarContextByImage, type RetrievedProduct } from './services/rag';
import { logger } from './logger';
import { getProductsForCarousel, shouldShowCarousel } from './utils/ai-product-matcher';
import { downloadImageAsBase64, isValidImageUrl } from './utils/image';
import { env } from './config';
import { findOrCreateCustomer, createOrder } from './services/orders';

export type ConversationResponse = { text: string; products?: RetrievedProduct[] };

export type ConversationOptions = {
  mid?: string | undefined;
  imageUrl?: string | undefined;
};

export async function handleConversation(
  userId: string,
  userMessageText: string,
  opts?: ConversationOptions
): Promise<ConversationResponse> {
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

    // Save what they're looking for, but stay in browsing mode
    await updateLead(userId, { item: msg });
    // Don't change stage yet - let them browse products first
    // Flow continues to general chat section below
  }
  if (lead.stage === 'ask_name') {
    await updateLead(userId, { name: msg, stage: 'ask_phone' });
    await saveAssistantMessage(userId, prompts.askPhone);
    return { text: prompts.askPhone };
  }
  if (lead.stage === 'ask_phone') {
    const norm = normalizePhone(msg, 'KH');
    await updateLead(userId, { phone: norm.e164 ?? msg, stage: 'ask_email' });
    await saveAssistantMessage(userId, prompts.askEmail);
    return { text: prompts.askEmail };
  }
  if (lead.stage === 'ask_email') {
    // Email is optional - allow . to skip
    const skipEmail = msg.trim() === '.' || msg.toLowerCase().includes('skip');
    const email = skipEmail ? null : msg.trim();
    await updateLead(userId, { email, stage: 'ask_address' });
    await saveAssistantMessage(userId, prompts.askAddress);
    return { text: prompts.askAddress };
  }
  if (lead.stage === 'ask_address') {
    await updateLead(userId, { address: msg, stage: 'completed' });
    await saveAssistantMessage(userId, prompts.done);
    return { text: prompts.done };
  }

  // Handle order confirmation
  if (lead.stage === 'confirm_order') {
    const lower = msg.toLowerCase().trim();
    
    if (lower === 'yes' || lower === 'confirm' || lower === 'ok') {
      // User confirmed order
      if (!lead.pendingOrder || !lead.name || !lead.phone || !lead.address) {
        await updateLead(userId, { stage: 'completed', pendingOrder: null });
        const errorMsg = 'Sorry, there was an issue with your order. Please start again.';
        await saveAssistantMessage(userId, errorMsg);
        return { text: errorMsg };
      }

      try {
        logger.info({ userId, pendingOrder: lead.pendingOrder }, '📦 Creating order');

        // Create customer
        const customer = await findOrCreateCustomer(
          lead.name,
          lead.phone,
          undefined,
          lead.address
        );

        // Create order
        const order = await createOrder(
          customer.id,
          lead.pendingOrder.items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price
          })),
          'pending'
        );

        logger.info(
          { userId, orderId: order.id, total: order.total },
          '✅ Order created successfully'
        );

        // Update lead
        await updateLead(userId, {
          stage: 'completed',
          lastOrderId: order.id,
          pendingOrder: null
        });

        const confirmMsg = orderConfirmedPrompt(order.id, order.total);
        await saveAssistantMessage(userId, confirmMsg);
        return { text: confirmMsg };

      } catch (error: any) {
        logger.error({ userId, error: error.message }, '❌ Failed to create order');
        const errorMsg = 'Sorry, there was an error processing your order. Please try again later.';
        await saveAssistantMessage(userId, errorMsg);
        return { text: errorMsg };
      }
    } else if (lower === 'no' || lower === 'cancel') {
      // User cancelled order
      await updateLead(userId, { stage: 'completed', pendingOrder: null });
      const cancelMsg = prompts.orderCancelled;
      await saveAssistantMessage(userId, cancelMsg);
      return { text: cancelMsg };
    } else {
      // Invalid response, ask again
      const retryMsg = 'Please reply with YES to confirm or NO to cancel.';
      await saveAssistantMessage(userId, retryMsg);
      return { text: retryMsg };
    }
  }
  
  // General chat - check if user is asking about products OR sent an image
  let allProducts: RetrievedProduct[] | undefined;
  let productsToDisplay: RetrievedProduct[] | undefined;
  const lowerMsg = msg.toLowerCase();
  const isProductQuery = /\b(product|shoe|sneaker|item|what.*have|show|looking for|buy|purchase|available|pant|shirt|jacket|dress|wear|similar|like this)\b/i.test(lowerMsg);
  const hasImage = opts?.imageUrl && isValidImageUrl(opts.imageUrl);
  
  // Image-based search: prioritize visual similarity
  if (hasImage) {
    try {
      logger.info({ userId, imageUrl: opts.imageUrl?.slice(0, 100) }, '🖼️ RAG: Image-based product search');
      
      // Download and convert image to base64
      const imageBase64 = await downloadImageAsBase64(opts.imageUrl!, env.PAGE_ACCESS_TOKEN);
      
      // Search by image - retrieve 5 for AI context, but will show only top 1
      allProducts = await retrieveSimilarContextByImage(imageBase64, { matchCount: 5, minSimilarity: 0 });
      
      if (allProducts && allProducts.length > 0) {
        logger.info(
          {
            userId,
            retrieved: allProducts.length,
            topMatch: allProducts[0]?.name,
            topSimilarity: allProducts[0]?.similarity
          },
          '✅ RAG: Products retrieved by image (will show top 1 only)'
        );
      } else {
        logger.info({ userId }, '⚠️ RAG: No products found for image');
      }
    } catch (err: any) {
      logger.error({ userId, error: err.message }, '❌ RAG: Image-based retrieval failed');
      // Fallback to text-based search if available
      if (isProductQuery && msg.length > 0) {
        logger.info({ userId }, '🔄 Falling back to text-based search');
        try {
          allProducts = await retrieveSimilarContext(msg, { matchCount: 5, minSimilarity: 0 });
        } catch {}
      }
    }
  } 
  // Text-based search: use query text
  else if (isProductQuery && msg.length > 0) {
    try {
      logger.info({ userId, query: msg }, '🔍 RAG: Text-based product search');
      allProducts = await retrieveSimilarContext(msg, { matchCount: 5, minSimilarity: 0 });
      
      if (allProducts && allProducts.length > 0) {
        logger.info(
          {
            userId,
            retrieved: allProducts.length,
            topMatch: allProducts[0]?.name,
            topSimilarity: allProducts[0]?.similarity
          },
          '✅ RAG: Products retrieved by text'
        );
      }
    } catch (err: any) {
      logger.error({ userId, error: err.message }, '❌ RAG: Text-based retrieval failed');
    }
  }
  
  // Generate AI response with product context
  // For image searches, add context to the message
  const contextualMessage = hasImage && allProducts && allProducts.length > 0
    ? `[User sent an image] ${msg || 'Looking for products similar to this image'}`
    : msg;
  
  const reply = await generateAiReplyWithHistory(userId, contextualMessage, lead, allProducts);
  
  // IMPORTANT: Only create order when user CONFIRMS a specific product, not just says "buy"
  // Check for explicit confirmation: "I'll take it", "I want this one", "yes I'll buy this"
  const confirmKeywords = ['i\'ll take', 'i will take', 'i want this', 'i want that', 'buy this', 'buy that', 'yes', 'confirm'];
  const isConfirmingOrder = confirmKeywords.some(keyword => lowerMsg.includes(keyword)) && 
                            allProducts && allProducts.length > 0 && 
                            lowerMsg.length < 100; // Short confirmations only
  
  // Only create order if:
  // 1. User is confirming (not just browsing)
  // 2. Products are available
  // 3. User info is collected
  if (isConfirmingOrder && allProducts && allProducts.length > 0 && lead.name && lead.phone && lead.address) {
    // Extract order items from AI response and products
    const orderItems = allProducts.slice(0, 2).map(product => ({
      productId: product.id,
      productName: product.name,
      quantity: 1, // Default quantity, could be extracted from message
      price: product.price || 0
    }));

    const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Save pending order
    await updateLead(userId, {
      stage: 'confirm_order',
      pendingOrder: { items: orderItems, total }
    });

    const confirmMsg = confirmOrderPrompt(
      orderItems.map(item => ({
        name: item.productName,
        qty: item.quantity,
        price: item.price
      })),
      total
    );

    logger.info({ userId, orderItems, total }, '🛒 Pending order created, awaiting confirmation');
    await saveAssistantMessage(userId, confirmMsg);
    return { text: confirmMsg };
  }
  
  // IMPORTANT: Filter products based on what AI actually mentioned in response
  // This prevents showing irrelevant products (e.g., shoes when AI recommends pants)
  if (allProducts && allProducts.length > 0) {
    if (shouldShowCarousel(reply, allProducts)) {
      // For image search: show ONLY the top 1 match
      // For text search: show up to 2 products
      const maxProducts = hasImage ? 1 : 2;
      
      productsToDisplay = getProductsForCarousel(reply, allProducts, maxProducts, 0.3);
      
      if (productsToDisplay.length === 0) {
        logger.info({ userId }, '📊 No products matched AI recommendation, skipping carousel');
      } else {
        logger.info(
          { userId, displayCount: productsToDisplay.length, searchType: hasImage ? 'image' : 'text' },
          `✅ Showing ${productsToDisplay.length} product(s) in carousel`
        );
      }
    } else {
      logger.info({ userId }, '📊 Products quality too low or not mentioned, skipping carousel');
    }
  }
  
  // Non-blocking persistence
  saveAssistantMessage(userId, reply).catch(() => {});
  if (Math.random() < 0.1) refreshThreadSummary(userId).catch(() => {});
  return productsToDisplay && productsToDisplay.length > 0 
    ? { text: reply, products: productsToDisplay } 
    : { text: reply };
}


