import { supabase } from '../core/supabase';
import { env } from '../core/config';
import { logger } from '../core/logger';

export type ConversationStage = 
  | 'ask_item' 
  | 'ask_name' 
  | 'ask_phone'
  | 'ask_email'
  | 'ask_address' 
  | 'completed'
  | 'confirm_order'
  | 'processing_order';

export type OrderItem = {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
};

export type ProductInfo = {
  id: string;
  name: string;
  price: number;
  similarity?: number;
};

export type LeadDoc = {
  id?: string;
  userId: string;
  item?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  stage: ConversationStage;
  pendingOrder?: {
    items: OrderItem[];
    total: number;
  } | null;
  lastOrderId?: string | null;
  lastShownProducts?: ProductInfo[] | null;  // NEW: Store products from last product query
};

/**
 * Get or create lead in Supabase
 */
export async function getOrCreateLead(userId: string): Promise<LeadDoc> {
  const tenantId = env.PRODUCT_TENANT_ID;

  // Try to find existing lead
  const { data: existing, error: findError } = await supabase
    .from('leads')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();

  if (existing && !findError) {
    return {
      id: existing.id,
      userId: existing.user_id,
      item: existing.item,
      name: existing.name,
      phone: existing.phone,
      email: existing.email,
      address: existing.address,
      stage: existing.stage as ConversationStage,
      pendingOrder: existing.pending_order,
      lastOrderId: existing.last_order_id,
      lastShownProducts: existing.last_shown_products
    };
  }

  // Create new lead
  const { data: newLead, error: createError } = await supabase
    .from('leads')
    .insert({
      user_id: userId,
      stage: 'ask_item',
      tenant_id: tenantId
    })
    .select()
    .single();

  if (createError || !newLead) {
    logger.error({ error: createError, userId }, '❌ Failed to create lead');
    throw new Error('Failed to create lead');
  }

  logger.info({ userId, leadId: newLead.id }, '✅ Lead created');

  return {
    id: newLead.id,
    userId: newLead.user_id,
    stage: newLead.stage as ConversationStage
  };
}

/**
 * Update lead in Supabase
 */
export async function updateLead(userId: string, updates: Partial<LeadDoc>): Promise<void> {
  const tenantId = env.PRODUCT_TENANT_ID;

  // Convert camelCase to snake_case for Supabase
  const dbUpdates: any = {};
  
  if (updates.item !== undefined) dbUpdates.item = updates.item;
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
  if (updates.email !== undefined) dbUpdates.email = updates.email;
  if (updates.address !== undefined) dbUpdates.address = updates.address;
  if (updates.stage !== undefined) dbUpdates.stage = updates.stage;
  if (updates.pendingOrder !== undefined) dbUpdates.pending_order = updates.pendingOrder;
  if (updates.lastOrderId !== undefined) dbUpdates.last_order_id = updates.lastOrderId;
  if (updates.lastShownProducts !== undefined) dbUpdates.last_shown_products = updates.lastShownProducts;

  const { error } = await supabase
    .from('leads')
    .update(dbUpdates)
    .eq('user_id', userId)
    .eq('tenant_id', tenantId);

  if (error) {
    logger.error({ error, userId, updates }, '❌ Failed to update lead');
    throw new Error('Failed to update lead');
  }

  logger.debug({ userId, updates: Object.keys(updates) }, '✅ Lead updated');
}

