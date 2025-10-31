import { supabase } from '../core/supabase';
import { env } from '../core/config';
import { logger } from '../core/logger';
import { maskPhone } from '../security/validators';
import { Customer, Order } from '../types/domain';


/**
 * Find or create customer in Supabase
 * If existingCustomerId is provided, updates that customer instead of creating new
 */
export async function findOrCreateCustomer(
  name: string,
  phone: string,
  email?: string,
  address?: string,
  existingCustomerId?: string | null
): Promise<Customer> {
  const tenantId = env.PRODUCT_TENANT_ID;

  // If we have an existing customer ID, update that customer
  if (existingCustomerId) {
    logger.info({ customerId: existingCustomerId }, '🔄 Updating existing customer');
    
    const { data: updated, error: updateError } = await supabase
      .from('customers')
      .update({
        name,
        phone,
        email: email || null,
        address: address || null
      })
      .eq('id', existingCustomerId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (updated && !updateError) {
      logger.info({ customerId: updated.id, phone: maskPhone(phone) }, '✅ Customer updated');
      return {
        id: updated.id,
        name: updated.name,
        phone: updated.phone,
        email: updated.email,
        address: updated.address
      };
    }
    
    // If update fails, fall through to find/create logic
    logger.warn({ error: updateError, customerId: existingCustomerId }, 'Failed to update customer, trying find/create');
  }

  // Try to find existing customer by phone
  const { data: existing, error: findError } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .eq('tenant_id', tenantId)
    .single();

  if (existing && !findError) {
    logger.info({ customerId: existing.id, phone: maskPhone(phone) }, '✅ Customer found');
    return {
      id: existing.id,
      name: existing.name,
      phone: existing.phone,
      email: existing.email,
      address: existing.address
    };
  }

  // Create new customer
  const { data: newCustomer, error: createError } = await supabase
    .from('customers')
    .insert({
      name,
      phone,
      email: email || null,
      address: address || null,
      tenant_id: tenantId
    })
    .select()
    .single();

  if (createError) {
    logger.error({ error: createError, phone: maskPhone(phone) }, 'Failed to create customer');
    throw new Error('Failed to create customer');
  }

  logger.info({ customerId: newCustomer.id, phone: maskPhone(phone) }, '✅ Customer created');
  return {
    id: newCustomer.id,
    name: newCustomer.name,
    phone: newCustomer.phone,
    email: newCustomer.email,
    address: newCustomer.address
  };
}

/**
 * Create order with items (with retry logic)
 */
export async function createOrder(
  customerId: string,
  items: Array<{ productId: string; quantity: number; price: number }>,
  status: 'pending' | 'paid' = 'pending'
): Promise<Order> {
  const tenantId = env.PRODUCT_TENANT_ID;

  if (!tenantId) {
    logger.error({ customerId }, ' PRODUCT_TENANT_ID not configured');
    throw new Error('System configuration error');
  }

  if (!items || items.length === 0) {
    logger.error({ customerId }, ' No items provided for order');
    throw new Error('Cannot create order without items');
  }

  // Calculate total
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  logger.info(
    { customerId, itemCount: items.length, total, tenantId },
    '📝 Creating order...'
  );

  // Create order
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      customer_id: customerId,
      date: new Date().toISOString().split('T')[0],
      status,
      total,
      tenant_id: tenantId
    })
    .select()
    .single();

  if (orderError || !order) {
    logger.error({ 
      error: orderError, 
      errorDetails: JSON.stringify(orderError),
      customerId, 
      tenantId 
    }, ' Failed to create order in database');
    throw new Error(`Failed to create order: ${orderError?.message || 'Unknown error'}`);
  }

  logger.info({ orderId: order.id, customerId }, ' Order record created');

  // Create order items
  const orderItems = items.map((item) => ({
    order_id: order.id,
    product_id: item.productId,
    qty: item.quantity,
    price: item.price,
    tenant_id: tenantId
  }));

  const { data: createdItems, error: itemsError } = await supabase
    .from('order_items')
    .insert(orderItems)
    .select();

  if (itemsError) {
    logger.error({ 
      error: itemsError, 
      errorDetails: JSON.stringify(itemsError),
      orderId: order.id 
    }, ' Failed to create order items');
    
    // Rollback order
    logger.warn({ orderId: order.id }, '🔄 Rolling back order...');
    const { error: deleteError } = await supabase.from('orders').delete().eq('id', order.id);
    
    if (deleteError) {
      logger.error({ error: deleteError, orderId: order.id }, ' Failed to rollback order!');
    }
    
    throw new Error(`Failed to create order items: ${itemsError?.message || 'Unknown error'}`);
  }

  logger.info(
    { 
      orderId: order.id, 
      customerId, 
      itemCount: createdItems?.length || 0, 
      total,
      status: order.status
    },
    'ORDER SAVED SUCCESSFULLY'
  );

  return {
    id: order.id,
    customer_id: customerId,
    date: order.date,
    status: order.status,
    total: order.total,
    items: items.map((item) => ({
      product_id: item.productId,
      product_name: '', // Will be populated later if needed
      qty: item.quantity,
      price: item.price
    }))
  };
}

/**
 * Get order by ID
 */
export async function getOrder(orderId: string): Promise<Order | null> {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    logger.error({ error: orderError, orderId }, 'Order not found');
    return null;
  }

  // Get order items with product details
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select(`
      product_id,
      qty,
      price,
      products(name)
    `)
    .eq('order_id', orderId);

  if (itemsError) {
    logger.error({ error: itemsError, orderId }, 'Failed to fetch order items');
    return null;
  }

  return {
    id: order.id,
    customer_id: order.customer_id,
    date: order.date,
    status: order.status,
    total: order.total,
    items: (items || []).map((item: any) => ({
      product_id: item.product_id,
      product_name: item.products?.name || 'Unknown Product',
      qty: item.qty,
      price: item.price
    }))
  };
}

/**
 * Update order status
 */
export async function updateOrderStatus(
  orderId: string,
  status: 'pending' | 'paid' | 'refunded'
): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId);

  if (error) {
    logger.error({ error, orderId, status }, 'Failed to update order status');
    throw new Error('Failed to update order status');
  }

  logger.info({ orderId, status }, ' Order status updated');
}

/**
 * Accept order (mark as paid and decrement stock)
 */
export async function acceptOrder(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('accept_order', { p_order_id: orderId });

  if (error) {
    logger.error({ error, orderId }, '❌ Failed to accept order');
    throw new Error(error.message || 'Failed to accept order');
  }

  logger.info({ orderId }, 'Order accepted and stock decremented');
}

