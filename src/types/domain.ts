// Lanugage Types 
export type Language = 'km' | 'en'; // km = Khmer, en = English

// Chat Types 
export type ChatMessage = {
    id?: string;
    userId: string;
    role: 'user' | 'assistant';
    content: string;
    messageId?: string;
    createdAt?: string;
  };
  // Order Types 
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
  