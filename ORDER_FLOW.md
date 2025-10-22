# 🛒 Order Management System - Complete Flow

## Overview
Your Facebook Messenger chatbot now has a complete order management system that:
1. Extracts customer information from conversation
2. Helps users browse products via RAG search
3. Places orders directly through the chat
4. Stores everything in Supabase (customers, orders, order_items)

---

## 📋 Order Flow

### **Step 1: Customer Browses Products**
```
User: "I want blue sneakers"
Bot: [Shows 1-2 matching products via RAG]
     "I found Classic High-Top Canvas Sneakers for $44.99. 
      Would you like to order?"
```

### **Step 2: Customer Expresses Interest**
```
User: "I want to buy this" or "I'll purchase 2"
Bot: [Detects order keywords: buy, purchase, order, etc.]
```

**Order Keywords Detected:**
- buy
- purchase
- order
- i want
- i'll take
- get me

### **Step 3: System Checks Customer Info**

**If user has complete info (name, phone, address):**
→ Proceed to order confirmation (Step 4)

**If missing info:**
→ Collect via conversation stages:
1. `ask_name`: "May I have your full name?"
2. `ask_phone`: "What's your phone number?"
3. `ask_address`: "Where should we deliver?"

### **Step 4: Order Confirmation**
```
Bot: "To confirm your order:

  - 1x Classic High-Top Canvas Sneakers ($44.99 each)
  - 1x Blue T-Shirt ($19.99 each)

Total: $64.98

Reply YES to proceed or NO to cancel."

Stage: confirm_order
```

### **Step 5A: User Confirms (YES)**
```
User: "YES"

System Process:
1. Find or create customer in Supabase
2. Create order record (status: pending)
3. Create order_items for each product
4. Return order ID

Bot: "✅ Order confirmed!

Order ID: 123e4567-e89b-12d3-a456-426614174000
Total: $64.98

We'll contact you shortly for payment and delivery. Thank you! 🎉"
```

### **Step 5B: User Cancels (NO)**
```
User: "NO"

Bot: "No problem! Let me know if you'd like to order something else. 😊"
Stage: completed
Pending order cleared
```

---

## 🗄️ Database Schema

### **Customers Table**
```sql
customers (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  phone       text NOT NULL,
  email       text,
  address     text,
  tenant_id   uuid,
  created_at  timestamptz,
  updated_at  timestamptz
)
```

### **Orders Table**
```sql
orders (
  id           uuid PRIMARY KEY,
  customer_id  uuid REFERENCES customers(id),
  date         date DEFAULT current_date,
  status       text CHECK (status IN ('paid','refunded','pending')),
  total        numeric,
  tenant_id    uuid,
  created_at   timestamptz,
  updated_at   timestamptz
)
```

### **Order Items Table**
```sql
order_items (
  id          uuid PRIMARY KEY,
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  product_id  uuid REFERENCES products(id),
  qty         integer CHECK (qty > 0),
  price       numeric,
  tenant_id   uuid,
  created_at  timestamptz,
  updated_at  timestamptz
)
```

---

## 🔧 Key Components

### **1. Order Service** (`src/services/orders.ts`)

**Functions:**
- `findOrCreateCustomer(name, phone, email?, address?)` 
  - Searches by phone + tenant_id
  - Creates new if not found
  
- `createOrder(customerId, items, status='pending')`
  - Creates order with calculated total
  - Creates order_items in same transaction
  - Returns Order object

- `getOrder(orderId)`
  - Fetches order with items and product names
  
- `updateOrderStatus(orderId, status)`
  - Updates order status

- `acceptOrder(orderId)`
  - Calls Supabase RPC `accept_order`
  - Marks order as 'paid'
  - Decrements product stock

### **2. Conversation Stages** (`src/services/leads.ts`)

**New Stages:**
- `confirm_order`: Waiting for YES/NO confirmation
- `processing_order`: Creating order in database

**New Lead Fields:**
- `pendingOrder`:
  ```typescript
  {
    items: Array<{
      productId: string;
      productName: string;
      quantity: number;
      price: number;
    }>;
    total: number;
  }
  ```
- `lastOrderId`: UUID of last created order

### **3. Order Detection** (`src/conversation.ts`)

```typescript
const orderKeywords = ['buy', 'purchase', 'order', 'i want', 'i\'ll take', 'get me'];
const wantsToOrder = orderKeywords.some(keyword => lowerMsg.includes(keyword));

if (wantsToOrder && allProducts && allProducts.length > 0 && 
    lead.name && lead.phone && lead.address) {
  // Create pending order
  // Show confirmation message
  // Set stage to 'confirm_order'
}
```

---

## 🎯 Example Complete Conversation

```
User: "Hi"
Bot: "What product are you looking for today? 💬"

User: "blue sneakers"
Bot: [RAG search finds products]
     "I found Classic High-Top Canvas Sneakers in Cyan Blue for $44.99..."
     [Shows product carousel]

User: "I want to buy this"
Bot: "Great! May I have your full name?"
Stage: ask_name

User: "John Doe"
Bot: "Thanks! What is the best phone number to reach you?"
Stage: ask_phone

User: "+855123456789"
Bot: "Got it. Finally, could you provide your delivery address?"
Stage: ask_address

User: "123 Street, Phnom Penh"
Bot: "To confirm your order:

  - 1x Classic High-Top Canvas Sneakers ($44.99 each)

Total: $44.99

Reply YES to proceed or NO to cancel."
Stage: confirm_order

User: "YES"
Bot: "✅ Order confirmed!

Order ID: abc123...
Total: $44.99

We'll contact you shortly for payment and delivery. Thank you! 🎉"
Stage: completed

[Supabase records created]:
- Customer: John Doe (+855123456789)
- Order: abc123 ($44.99, pending)
- Order Item: 1x product_id → order_id
```

---

## ⚙️ Configuration

### **Environment Variables** (`.env`)
```env
# Tenant ID for filtering products and orders
PRODUCT_TENANT_ID=db3ca566-c6ec-4739-9537-fef4337e2c36

# Supabase credentials
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...
```

---

## 🧪 Testing the Order Flow

### **1. Start the server:**
```bash
npm run dev
```

### **2. Send messages to your Facebook page:**

**Test 1: Complete Order Flow**
```
1. "show me shoes"
2. "I want to buy these"
3. "John Doe"
4. "+85512345678"
5. "123 Main St"
6. "YES"
```

**Test 2: Order Cancellation**
```
1. "I want blue sneakers"
2. "I'll buy it"
3. [Complete info collection]
4. "NO" ← Cancel order
```

**Test 3: Order with Existing Customer**
```
1. User who already has name/phone/address saved
2. "I want to order red shoes"
3. "YES" ← Should skip info collection
```

### **3. Check logs:**
```
🔍 RAG: Text-based product search
✅ RAG TEXT SEARCH SUCCESS
🛒 Pending order created, awaiting confirmation
📦 Creating order
✅ Customer created (or found)
✅ Order created successfully
   orderId: abc-123...
   total: 44.99
```

### **4. Verify in Supabase:**
```sql
SELECT * FROM customers WHERE phone = '+85512345678';
SELECT * FROM orders WHERE customer_id = 'xxx';
SELECT * FROM order_items WHERE order_id = 'xxx';
```

---

## 🚀 Next Steps

### **Accept Order (Mark as Paid):**
```typescript
import { acceptOrder } from './services/orders';

// When payment is confirmed:
await acceptOrder(orderId);
// ✅ Order status → 'paid'
// ✅ Product stock decremented
```

### **View Orders:**
```typescript
import { getOrder } from './services/orders';

const order = await getOrder(orderId);
console.log(order.items); // Product details included
```

### **Quantity Extraction (Future Enhancement):**
```typescript
// Currently defaults to qty: 1
// Could extract from messages like:
// "I want 2 blue sneakers and 3 red shirts"

function extractQuantities(message: string): Record<string, number> {
  // Parse "2 blue sneakers" → { "blue sneakers": 2 }
}
```

---

## 📊 Order Status Flow

```
pending → paid → (optional: refunded)
   ↑         ↑
   |         └─ acceptOrder() RPC
   └─ createOrder()
```

**Status Values:**
- `pending`: Order created, awaiting payment
- `paid`: Payment confirmed, stock decremented
- `refunded`: Order refunded (stock restored manually)

---

## 🎨 Customization

### **Change Order Confirmation Message:**
Edit `src/prompts.ts`:
```typescript
export function confirmOrderPrompt(items, total): string {
  return `Your custom confirmation message...`;
}
```

### **Add Payment Integration:**
```typescript
// In src/conversation.ts after order creation:
const paymentLink = await generatePaymentLink(order.id, total);
return { text: `Order confirmed! Pay here: ${paymentLink}` };
```

### **Modify Default Quantity:**
```typescript
// In src/conversation.ts line 240:
quantity: extractQuantityFromMessage(msg) || 1,
```

---

## ✅ Summary

Your chatbot now has a **complete e-commerce order flow**:

✅ **RAG-powered product discovery** (text + image search)  
✅ **Automatic customer info extraction** (name, phone, address)  
✅ **Order creation & confirmation** (YES/NO flow)  
✅ **Supabase integration** (customers, orders, order_items)  
✅ **Tenant isolation** (multi-tenant support)  
✅ **Stock management** (via `accept_order` RPC)  
✅ **Beautiful logs** (pino-pretty, real-time updates)  

**Ready to take orders! 🎉**

