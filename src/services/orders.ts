import { supabase } from '../supabase';
import { env } from '../config';
import { logger } from '../logger';

export type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  address?: string | null;
};

export type OrderItem = {
  product_id: string;
  product_name: string;
  qty: number;
  price: number;
};

export type Order = {
  id: string;
  customer_id: string;
  date: string;
  status: 'pending' | 'paid' | 'refunded';
  total: number;
  items: OrderItem[];
};

/**
 * Find or create customer in Supabase
 */
export async function findOrCreateCustomer(
  name: string,
  phone: string,
  email?: string,
  address?: string
): Promise<Customer> {
  const tenantId = env.PRODUCT_TENANT_ID;

  // Try to find existing customer by phone
  const { data: existing, error: findError } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .eq('tenant_id', tenantId)
    .single();

  if (existing && !findError) {
    logger.info({ customerId: existing.id, phone }, '✅ Customer found');
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
    logger.error({ error: createError, phone }, '❌ Failed to create customer');
    throw new Error('Failed to create customer');
  }

  logger.info({ customerId: newCustomer.id, phone }, '✅ Customer created');
  return {
    id: newCustomer.id,
    name: newCustomer.name,
    phone: newCustomer.phone,
    email: newCustomer.email,
    address: newCustomer.address
  };
}

/**
 * Create order with items
 */
export async function createOrder(
  customerId: string,
  items: Array<{ productId: string; quantity: number; price: number }>,
  status: 'pending' | 'paid' = 'pending'
): Promise<Order> {
  const tenantId = env.PRODUCT_TENANT_ID;

  // Calculate total
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

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

  if (orderError) {
    logger.error({ error: orderError, customerId }, '❌ Failed to create order');
    throw new Error('Failed to create order');
  }

  // Create order items
  const orderItems = items.map((item) => ({
    order_id: order.id,
    product_id: item.productId,
    qty: item.quantity,
    price: item.price,
    tenant_id: tenantId
  }));

  const { error: itemsError } = await supabase
    .from('order_items')
    .insert(orderItems);

  if (itemsError) {
    logger.error({ error: itemsError, orderId: order.id }, '❌ Failed to create order items');
    // Rollback order
    await supabase.from('orders').delete().eq('id', order.id);
    throw new Error('Failed to create order items');
  }

  logger.info(
    { orderId: order.id, customerId, itemCount: items.length, total },
    '✅ Order created successfully'
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
    logger.error({ error: orderError, orderId }, '❌ Order not found');
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
    logger.error({ error: itemsError, orderId }, '❌ Failed to fetch order items');
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
    logger.error({ error, orderId, status }, '❌ Failed to update order status');
    throw new Error('Failed to update order status');
  }

  logger.info({ orderId, status }, '✅ Order status updated');
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

  logger.info({ orderId }, '✅ Order accepted and stock decremented');
}

