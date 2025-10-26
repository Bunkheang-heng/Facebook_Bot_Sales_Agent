import { type Order, type OrderItem } from '../services/orders';

/**
 * Format order summary for Facebook Messenger
 */
export function formatOrderSummary(
  customerName: string,
  items: Array<{ name: string; quantity: number; price: number }>,
  total: number
): string {
  const itemLines = items.map((item, idx) => {
    const subtotal = item.price * item.quantity;
    return `${idx + 1}. ${item.name}\n   Qty: ${item.quantity} x $${item.price.toFixed(2)} = $${subtotal.toFixed(2)}`;
  });

  return `ORDER SUMMARY

Customer: ${customerName}

${itemLines.join('\n\n')}

TOTAL: $${total.toFixed(2)}

Reply YES to confirm or CANCEL to cancel this order.`;
}

/**
 * Format order confirmation message
 */
export function formatOrderConfirmation(orderId: string, total: number): string {
  return `✅ Order Confirmed!

Order ID: ${orderId}
Total: $${total.toFixed(2)}
Status: Pending Payment

We'll contact you shortly to arrange payment and delivery. Thank you!`;
}

/**
 * Extract product quantities from AI response
 * Example: "I want 2 blue sneakers and 1 red shirt"
 * Returns: [{ productId: 'xxx', quantity: 2 }, ...]
 */
export function extractOrderIntent(message: string): {
  wantsToOrder: boolean;
  quantities?: Record<string, number>;
} {
  const lower = message.toLowerCase();
  
  // Check if user wants to order
  const orderKeywords = [
    'buy', 'purchase', 'order', 'want to buy', 'i\'ll take',
    'add to cart', 'checkout', 'i want', 'get me'
  ];
  
  const wantsToOrder = orderKeywords.some(keyword => lower.includes(keyword));
  
  if (!wantsToOrder) {
    return { wantsToOrder: false };
  }

  // Extract quantities (e.g., "2 blue sneakers", "1 shirt")
  const quantityPattern = /(\d+)\s+(?:of\s+)?(.+?)(?:\s+and|\s*,|\s*$)/gi;
  const quantities: Record<string, number> = {};
  
  let match;
  while ((match = quantityPattern.exec(message)) !== null) {
    const qty = parseInt(match[1] || '0', 10);
    const productHint = match[2]?.trim();
    if (qty > 0 && productHint) {
      quantities[productHint] = qty;
    }
  }

  return { wantsToOrder, quantities };
}

