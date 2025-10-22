# 🗣️ Improved Conversation Flow

## Overview
The chatbot now has a **natural shopping experience** where users can browse products FIRST, then decide to buy. Information is only collected when the user is ready to make a purchase.

---

## 🎯 Complete Flow

### **Stage 1: Greeting**
```
User: "Hi"
Bot: "What product are you looking for today? 💬 
      You can also send me a photo and I'll find similar items!"

Stage: ask_item
```

---

### **Stage 2: Browsing (ask_item)**
```
User: "I want blue sneakers"
Bot: [RAG search finds products]
     [Shows 1-2 products in carousel]
     "I found Classic High-Top Canvas Sneakers in Cyan Blue for $44.99. 
      They feature a cushioned insole and durable outsole. 
      Would you like to order?"

Stage: ask_item (STAYS in browsing mode)
User can: 
  - Ask more questions
  - Browse different products
  - Send images to search
  - Say "I want to buy" to start ordering
```

**Key Point:** User stays in `ask_item` stage and can browse as long as they want!

---

### **Stage 3: Intent to Buy**
```
User: "I want to buy this" (or "purchase", "order", "I'll take it")
Bot: "Perfect! To complete your order, I'll need some information.
      
      What's your full name?"

Stage: ask_item → ask_name
```

**Trigger Keywords:**
- buy
- purchase  
- order
- i want
- i'll take
- get me
- i will buy

---

### **Stage 4: Information Collection**

#### **4A: Name (Required)**
```
User: "John Doe"
Bot: "Thanks! What's your phone number?"

Stage: ask_name → ask_phone
```

#### **4B: Phone (Required)**
```
User: "+855123456789"
Bot: "And your email? (optional - press . to skip)"

Stage: ask_phone → ask_email
```

#### **4C: Email (Optional)**
```
Option 1 - Provide email:
User: "john@email.com"
Bot: "Finally, what's your delivery address?"

Option 2 - Skip email:
User: "."
Bot: "Finally, what's your delivery address?"

Stage: ask_email → ask_address
```

**How to skip email:**
- Type `.` (dot)
- Type "skip"
- Any message with "skip" in it

#### **4D: Address (Required)**
```
User: "123 Main Street, Phnom Penh"
Bot: "Thank you! Your order has been received. 
      We'll contact you shortly for payment and delivery. 🎉"

Stage: ask_address → completed
```

---

### **Stage 5: Order Confirmation (for returning customers)**

If user already has name/phone/address saved:

```
User: "I want to buy blue sneakers"
Bot: [Shows products]

User: "I'll take it"
Bot: "To confirm your order:

      - 1x Classic High-Top Canvas Sneakers ($44.99 each)
      
      Total: $44.99
      
      Reply YES to proceed or NO to cancel."

Stage: confirm_order
```

#### **5A: Confirm Order**
```
User: "YES"
Bot: "✅ Order confirmed!

      Order ID: abc-123-456
      Total: $44.99
      
      We'll contact you shortly for payment and delivery. Thank you! 🎉"

Stage: confirm_order → completed
[Order created in Supabase]
```

#### **5B: Cancel Order**
```
User: "NO"
Bot: "No problem! Let me know if you'd like to order something else. 😊"

Stage: confirm_order → completed
[Pending order cleared]
```

---

## 📊 Stage Diagram

```
ask_item (browsing) ←──────────┐
    ↓                          │
    ↓ (when user says "buy")   │
    ↓                          │
ask_name (collecting info)      │
    ↓                          │
ask_phone                       │
    ↓                          │
ask_email (optional)            │
    ↓                          │
ask_address                     │
    ↓                          │
completed ──────────────────────┘
    OR
    ↓
confirm_order (if has info)
    ↓
completed
```

---

## ✅ Field Requirements

| Field | Required | How to Skip | Example |
|-------|----------|-------------|---------|
| **Name** | ✅ Yes | Cannot skip | John Doe |
| **Phone** | ✅ Yes | Cannot skip | +855123456789 |
| **Email** | ⚠️ Optional | Type `.` or "skip" | john@email.com |
| **Address** | ✅ Yes | Cannot skip | 123 Main St, Phnom Penh |

---

## 🎨 Example Conversations

### **Example 1: New Customer (First Time Order)**

```
User: "Hi"
Bot: "What product are you looking for today?"

User: "blue sneakers"
Bot: [Shows Classic High-Top Sneakers - $44.99]
     "I found these Classic High-Top Canvas Sneakers in Cyan Blue..."

User: "How much?"
Bot: "They're $44.99. Would you like to order them?"

User: "Yes I want to buy"
Bot: "Perfect! To complete your order, I'll need some information.
      What's your full name?"

User: "John Doe"
Bot: "Thanks! What's your phone number?"

User: "+855123456789"
Bot: "And your email? (optional - press . to skip)"

User: "."
Bot: "Finally, what's your delivery address?"

User: "123 Main Street"
Bot: "Thank you! Your order has been received. 
      We'll contact you shortly for payment and delivery. 🎉"
```

### **Example 2: Returning Customer (Has Info Saved)**

```
User: "Show me red shoes"
Bot: [Shows products]

User: "I'll take the first one"
Bot: "To confirm your order:
      - 1x Red Running Shoes ($59.99)
      Total: $59.99
      Reply YES to proceed or NO to cancel."

User: "YES"
Bot: "✅ Order confirmed! Order ID: xyz-789
      We'll contact you shortly!"
```

### **Example 3: Browse First, Buy Later**

```
User: "What products do you have?"
Bot: [Shows various products]

User: "Do you have blue items?"
Bot: [Shows blue products]

User: "What about size 42?"
Bot: [AI helps with sizing]

User: "OK I want to buy the blue sneakers"
Bot: "Perfect! To complete your order, I'll need some information..."
[Starts info collection]
```

---

## 🔧 Configuration

### **Order Keywords**
Edit in `src/conversation.ts`:
```typescript
const orderKeywords = [
  'buy', 'purchase', 'order', 
  'i want', 'i\'ll take', 'get me', 
  'i will buy'
];
```

### **Email Skip Logic**
Edit in `src/conversation.ts`:
```typescript
const skipEmail = msg.trim() === '.' || msg.toLowerCase().includes('skip');
```

---

## 🚀 Key Improvements

✅ **Natural browsing experience**
- Users can browse multiple products
- Ask questions about products
- No pressure to buy immediately

✅ **Clear information requirements**
- Users know what's required vs optional
- Email has clear skip instruction: `(optional - press . to skip)`

✅ **Smooth order flow**
- Info collected ONLY when ready to buy
- Returning customers get faster checkout
- Order confirmation before finalizing

✅ **Better AI behavior**
- AI helps users browse and ask questions
- No premature information collection
- Natural conversation flow

---

## 📝 Prompts Reference

| Prompt | When Used | Message |
|--------|-----------|---------|
| `askItem` | Greeting | "What product are you looking for today?" |
| `askName` | Start order | "Perfect! To complete your order... What's your full name?" |
| `askPhone` | After name | "Thanks! What's your phone number?" |
| `askEmail` | After phone | "And your email? (optional - press . to skip)" |
| `askAddress` | After email | "Finally, what's your delivery address?" |
| `done` | Info complete | "Thank you! Your order has been received..." |
| `orderConfirmed` | Order placed | "✅ Order confirmed! Order ID: ..." |
| `orderCancelled` | Order cancelled | "No problem! Let me know if..." |

---

## 🧪 Testing

**Test 1: Complete flow with optional email**
```
1. "show me products"
2. "I want blue sneakers"
3. "I'll buy it"
4. "John Doe"
5. "+855123456"
6. "."  ← Skip email
7. "123 Main St"
```

**Test 2: Complete flow with email**
```
[Same as above, but step 6:]
6. "john@example.com"  ← Provide email
```

**Test 3: Browse then buy**
```
1. "what do you have?"
2. [Browse products]
3. "I want to order"
4. [Provide info]
```

---

Your chatbot now provides a **professional e-commerce experience**! 🛍️

