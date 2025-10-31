import { getPrompts, confirmOrderPrompt, orderConfirmedPrompt } from './prompts';
import { getOrCreateLead, updateLead } from '../services/leads-supabase';
import { saveAssistantMessage, saveUserMessage } from '../services/history-supabase';
import { detectLanguage } from '../utils';
import { generateAiReplyWithHistory, refreshThreadSummary } from './ai';
import { normalizePhone } from '../services/phone';
import { retrieveSimilarContext, retrieveSimilarContextByImage, retrieveSimilarContextCombined, type RetrievedProduct } from '../services/rag';
import { logger } from './logger';
import { getProductsForCarousel, shouldShowCarousel } from '../lib/ai-product-matcher';
import { downloadImageAsBase64, isValidImageUrl } from '../social/image';
import { env } from './config';
import { findOrCreateCustomer, createOrder } from '../services/orders';
import { leadUpdateSchema, userMessageSchema, maskPhone, buildLeadUpdate } from '../security/validators';
import { formatOrderSummary, formatCustomerInfoReconfirm } from '../formatters/order-summary';

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
  const msg = userMessageSchema.safeParse(userMessageText).success
    ? userMessageText.trim()
    : String(userMessageText || '').slice(0, 800).trim();
  
  // Detect language from user message
  const language = detectLanguage(msg);
  const prompts = getPrompts(language);
  
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
    // Try to parse if user provided everything in one message (name, phone, address)
    const parts = msg.split(',').map(p => p.trim()).filter(p => p.length > 0);
    
    if (parts.length >= 3) {
      // User provided all info at once: name, phone, address
      const name = parts[0]!;
      const phone = parts[1]!;
      const addressParts = parts.slice(2);
      const address = addressParts.join(', ');
      const norm = normalizePhone(phone, 'KH');
      const normalizedPhone = norm.e164 ?? phone;
      
      logger.info({ userId, name, phone: maskPhone(normalizedPhone) }, '📝 User provided all info in one message');
      
      // Update with all info and move to show_order_summary if there's a pending order
      if (lead.pendingOrder && lead.pendingOrder.items && lead.pendingOrder.items.length > 0) {
        await updateLead(userId, {
          name: name,
          phone: normalizedPhone,
          email: null,
          address: address,
          stage: 'show_order_summary'
        });
        
        // Show order summary
        const summaryMsg = formatOrderSummary(
          lead.pendingOrder.items,
          lead.pendingOrder.total,
          name,
          normalizedPhone,
          null,
          address,
          language
        );
        
        await saveAssistantMessage(userId, summaryMsg);
        return { text: summaryMsg };
      } else {
        // No pending order, just save info
        await updateLead(userId, {
          name: name,
          phone: normalizedPhone,
          email: null,
          address: address,
          stage: 'completed'
        });
        await saveAssistantMessage(userId, prompts.done);
        return { text: prompts.done };
      }
    }
    
    // User only provided name, continue with stage-based flow
    const validated = leadUpdateSchema.parse({ name: msg, stage: 'ask_phone' });
    await updateLead(userId, buildLeadUpdate(validated));
    await saveAssistantMessage(userId, prompts.askPhone);
    return { text: prompts.askPhone };
  }
  if (lead.stage === 'ask_phone') {
    const norm = normalizePhone(msg, 'KH');
    const validated = leadUpdateSchema.parse({ phone: norm.e164 ?? msg, stage: 'ask_email' });
    await updateLead(userId, buildLeadUpdate(validated));
    await saveAssistantMessage(userId, prompts.askEmail);
    return { text: prompts.askEmail };
  }
  if (lead.stage === 'ask_email') {
    // Email is optional - allow . to skip
    const skipEmail = msg.trim() === '.' || msg.toLowerCase().includes('skip');
    const email = skipEmail ? null : msg.trim();
    const validated = leadUpdateSchema.parse({ email, stage: 'ask_address' });
    await updateLead(userId, buildLeadUpdate(validated));
    await saveAssistantMessage(userId, prompts.askAddress);
    return { text: prompts.askAddress };
  }
  if (lead.stage === 'ask_address') {
    const validated = leadUpdateSchema.parse({ address: msg });
    
    // If there's a pending order, show order summary next
    if (lead.pendingOrder && lead.pendingOrder.items && lead.pendingOrder.items.length > 0) {
      await updateLead(userId, { ...buildLeadUpdate(validated), stage: 'show_order_summary' });
      
      // Re-fetch lead to get updated info
      const updatedLead = await getOrCreateLead(userId);
      
      const summaryMsg = formatOrderSummary(
        lead.pendingOrder.items,
        lead.pendingOrder.total,
        updatedLead.name!,
        updatedLead.phone!,
        updatedLead.email,
        msg, // The address they just provided
        language
      );
      
      await saveAssistantMessage(userId, summaryMsg);
      return { text: summaryMsg };
    } else {
      // No pending order, just complete
      await updateLead(userId, { ...buildLeadUpdate(validated), stage: 'completed' });
      await saveAssistantMessage(userId, prompts.done);
      return { text: prompts.done };
    }
  }
  
  // Handle order summary review
  if (lead.stage === 'show_order_summary') {
    const lower = msg.toLowerCase().trim();
    
    if (lower === 'yes' || lower === 'confirm' || lower === 'ok') {
      // User confirmed the order summary, move to final confirmation
      await updateLead(userId, { stage: 'confirm_order' });
      
      const confirmMsg = language === 'km' 
        ? 'តើអ្នកបញ្ជាក់ការបញ្ជាទិញនេះមែនទេ? ឆ្លើយតប **YES** ដើម្បីបញ្ជាក់។'
        : 'Do you confirm this order? Reply **YES** to confirm.';
      
      await saveAssistantMessage(userId, confirmMsg);
      return { text: confirmMsg };
      
    } else if (lower === 'edit' || lower === 'change' || lower === 'update') {
      // Allow customer to edit their info
      logger.info({ userId }, '✏️ Customer wants to edit info');
      await updateLead(userId, { stage: 'ask_name' });
      const editMsg = prompts.askName;
      await saveAssistantMessage(userId, editMsg);
      return { text: editMsg };
      
    } else {
      // Invalid response, show instructions again
      const retryMsg = language === 'km'
        ? 'សូមឆ្លើយតប **YES** ដើម្បីបន្ត ឬ **EDIT** ដើម្បីកែប្រែព័ត៌មាន។'
        : 'Please reply **YES** to continue or **EDIT** to change information.';
      
      await saveAssistantMessage(userId, retryMsg);
      return { text: retryMsg };
    }
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
        logger.info({ 
          userId, 
          customerName: lead.name,
          customerPhone: maskPhone(lead.phone),
          pendingOrder: lead.pendingOrder 
        }, '📦 Starting order creation process');

        // Step 1: Create/find customer
        logger.info({ userId }, '👤 Creating/finding customer...');
        const customer = await findOrCreateCustomer(
          lead.name,
          lead.phone,
          lead.email || undefined,
          lead.address
        );
        logger.info({ userId, customerId: customer.id }, '✅ Customer ready');

        // Step 2: Validate order items
        if (!lead.pendingOrder?.items || lead.pendingOrder.items.length === 0) {
          throw new Error('No items in pending order');
        }

        // Step 3: Create order with items
        logger.info({ userId, customerId: customer.id }, '📝 Creating order in database...');
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
          { 
            userId, 
            orderId: order.id, 
            customerId: customer.id,
            total: order.total,
            itemCount: order.items.length
          },
          '✅✅✅ ORDER SAVED IN DATABASE'
        );

        // Step 4: Update lead state
        logger.info({ userId, orderId: order.id }, '💾 Updating lead state...');
        await updateLead(userId, {
          stage: 'completed',
          lastOrderId: order.id,
          pendingOrder: null
        });
        logger.info({ userId }, '✅ Lead updated');

        // Step 5: Send confirmation (using detected language)
        const confirmMsg = orderConfirmedPrompt(order.id, order.total, language);
        await saveAssistantMessage(userId, confirmMsg);
        
        logger.info(
          { 
            userId, 
            orderId: order.id,
            customerName: lead.name,
            total: order.total
          },
          '🎉 ORDER FLOW COMPLETED SUCCESSFULLY'
        );

        return { text: confirmMsg };

      } catch (error: any) {
        logger.error({ 
          userId, 
          error: error.message,
          stack: error.stack,
          leadData: {
            name: lead.name,
            phone: maskPhone(lead.phone),
            address: '[redacted]',
            hasPendingOrder: !!lead.pendingOrder
          }
        }, '❌❌❌ ORDER CREATION FAILED');
        
        const errorMsg = 'Sorry, there was an error processing your order. Please try again or contact support.';
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
  
  // IMPORTANT: Check if user is confirming an order (don't do RAG search for confirmations)
  const confirmKeywords = ['i\'ll take', 'i will take', 'i want this', 'i want that', 'buy this', 'buy that', 'i take', 'yes', 'confirm'];
  const isLikelyConfirming = confirmKeywords.some(keyword => lowerMsg.includes(keyword)) && lowerMsg.length < 100;
  
  const isProductQuery = /\b(product|shoe|sneaker|item|what.*have|show|looking for|buy|purchase|available|pant|shirt|jacket|dress|wear|similar|like this)\b/i.test(lowerMsg);
  const hasImage = opts?.imageUrl && isValidImageUrl(opts.imageUrl);
  
  // SKIP RAG if user is just confirming - they already saw products
  const shouldDoRAG = !isLikelyConfirming && (isProductQuery || hasImage);
  
  // IMPORTANT: Check if user is confirming order BEFORE doing RAG/AI
  // This prevents AI from generating responses when user is just saying "yes I'll take it"
  const isLikelyConfirmingEarly = isLikelyConfirming;
  
  // Check if we have products from previous interaction
  const hasProductsToConfirm = lead.lastShownProducts && lead.lastShownProducts.length > 0;
  
  // If user is confirming and has products, handle order immediately
  if (isLikelyConfirmingEarly && hasProductsToConfirm) {
    const orderItems = lead.lastShownProducts!.slice(0, 1).map(product => ({
      productId: product.id,
      productName: product.name,
      quantity: 1,
      price: product.price || 0
    }));

    const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    logger.info(
      { 
        userId, 
        selectedProduct: orderItems[0]?.productName,
        price: orderItems[0]?.price,
        total 
      }, 
      '🛒 User confirming order for previously shown product'
    );

    // Save pending order
    await updateLead(userId, {
      pendingOrder: { items: orderItems, total }
    });

    // Check if customer already has contact information
    const hasCompleteInfo = lead.name && lead.phone && lead.address;
    
    if (hasCompleteInfo) {
      // Customer exists - show their info and ask if they want to use it
      logger.info({ userId, customerName: lead.name }, '✅ Found existing customer info');
      
      const reconfirmMsg = formatCustomerInfoReconfirm(
        lead.name!,
        lead.phone!,
        lead.email ?? null,
        lead.address!,
        language
      );
      
      // Set stage to show_order_summary
      await updateLead(userId, { stage: 'show_order_summary' });
      await saveAssistantMessage(userId, reconfirmMsg);
      return { text: reconfirmMsg };
      
    } else {
      // No contact info - ask for name first
      logger.info({ userId }, '📝 No customer info, asking for details');
      await updateLead(userId, { stage: 'ask_name' });
      await saveAssistantMessage(userId, prompts.askName);
      return { text: prompts.askName };
    }
  }
  
  // RAG search strategy
  if (shouldDoRAG) {
    try {
      const hasQuestion = msg.length > 0 && isProductQuery;
      
      // STRATEGY 1: Image + Text (Combined RAG)
      if (hasImage && hasQuestion) {
        logger.info(
          { 
            userId, 
            imageUrl: opts.imageUrl?.slice(0, 100),
            query: msg.slice(0, 100)
          }, 
          '🔄 RAG: Combined image + text search'
        );
        
        const imageBase64 = await downloadImageAsBase64(opts.imageUrl!, env.PAGE_ACCESS_TOKEN);
        allProducts = await retrieveSimilarContextCombined(msg, imageBase64, { matchCount: 10, minSimilarity: 0 });
        
        if (allProducts && allProducts.length > 0) {
          logger.info(
            {
              userId,
              retrieved: allProducts.length,
              topMatch: allProducts[0]?.name,
              topSimilarity: allProducts[0]?.similarity
            },
            '✅ RAG: Combined search returned products'
          );
        }
      }
      // STRATEGY 2: Image-only (no text query)
      else if (hasImage) {
        logger.info(
          { 
            userId, 
            imageUrl: opts.imageUrl?.slice(0, 100)
          }, 
          '🖼️ RAG: Image-only search'
        );
        
        const imageBase64 = await downloadImageAsBase64(opts.imageUrl!, env.PAGE_ACCESS_TOKEN);
        allProducts = await retrieveSimilarContextByImage(imageBase64, { matchCount: 5, minSimilarity: 0 });
        
        if (allProducts && allProducts.length > 0) {
          logger.info(
            {
              userId,
              retrieved: allProducts.length,
              topMatch: allProducts[0]?.name,
              topSimilarity: allProducts[0]?.similarity
            },
            'RAG: Products retrieved by image'
          );
        }
      }
      // STRATEGY 3: Text-only (no image)
      else if (hasQuestion) {
        logger.info({ userId, query: msg }, '💬 RAG: Text-only product search');
        allProducts = await retrieveSimilarContext(msg, { minSimilarity: 0 });
        
        if (allProducts && allProducts.length > 0) {
          logger.info(
            {
              userId,
              retrieved: allProducts.length,
              topMatch: allProducts[0]?.name,
              topSimilarity: allProducts[0]?.similarity
            },
            'RAG: Products retrieved by text'
          );
        }
      }
    } catch (err: any) {
      logger.error({ userId, error: err.message }, 'RAG: Product search failed');
    }
  }
  
  // Store products when we retrieve them (for use in confirmations later)
  if (allProducts && allProducts.length > 0) {
    const productsToStore = allProducts.slice(0, 5).map(p => ({
      id: p.id,
      name: p.name,
      price: p.price || 0,
      similarity: p.similarity
    }));
    await updateLead(userId, { lastShownProducts: productsToStore });
    logger.info({ userId, productCount: productsToStore.length }, '💾 Stored last shown products for future confirmation');
  }
  
  // Generate AI response with product context
  // For image searches, add context to the message
  let contextualMessage = msg;
  
  if (hasImage && allProducts && allProducts.length > 0) {
    if (msg && msg.length > 0) {
      // User sent image WITH a question - pass both context and question to AI
      contextualMessage = `[User sent an image and asked: "${msg}"]`;
      logger.info({ userId, userQuestion: msg.slice(0, 100) }, '💬 AI will answer specific question about image results');
    } else {
      // User sent image WITHOUT text - generic similar product search
      contextualMessage = '[User sent an image] Looking for products similar to this image';
      logger.info({ userId }, '🖼️ AI will describe similar products found');
    }
  }
  
  // Get AI reply with detected language
  const { reply, language: aiLanguage } = await generateAiReplyWithHistory(userId, contextualMessage, lead, allProducts);
  
  // Use AI's language for order prompts (more reliable than initial detection)
  const orderLanguage = aiLanguage;
  
  // Note: Order confirmation is now handled earlier in the flow (before AI generation)
  // to prevent AI from generating its own order confirmation messages
  
  // IMPORTANT: Determine how many products to show based on query type
  if (allProducts && allProducts.length > 0) {
    // Check if user is asking for recommendations or browsing multiple options
    const isAskingForOptions = /\b(recommend|show|what.*have|options|choices|all|any)\b/i.test(lowerMsg);
    const isGeneralQuery = lowerMsg.split(' ').length <= 3; // Short queries like "shoes", "blue sneakers"
    
    let maxProducts = 2; // Default
    
    if (hasImage) {
      // Image search: show top 1 match
      maxProducts = 1;
    } else if (isAskingForOptions || isGeneralQuery) {
      // User wants to see options: show 4-5 products
      maxProducts = Math.min(allProducts.length, 5);
    } else {
      // Specific query: show 2-3 products
      maxProducts = Math.min(allProducts.length, 3);
    }
    
    if (shouldShowCarousel(reply, allProducts)) {
      productsToDisplay = getProductsForCarousel(reply, allProducts, maxProducts, 0.3);
      
      if (productsToDisplay.length === 0) {
        logger.info({ userId }, '📊 No products matched AI recommendation, skipping carousel');
      } else {
        logger.info(
          { 
            userId, 
            displayCount: productsToDisplay.length, 
            maxProducts,
            searchType: hasImage ? 'image' : isAskingForOptions ? 'options' : 'text' 
          },
          `✅ Showing ${productsToDisplay.length}/${allProducts.length} product(s) in carousel`
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


