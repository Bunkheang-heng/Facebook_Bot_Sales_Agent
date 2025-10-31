import { OrderItem } from '../services/leads-supabase';

/**
 * Format order summary for customer review
 */
export function formatOrderSummary(
  items: OrderItem[],
  total: number,
  customerName?: string | null,
  customerPhone?: string | null,
  customerEmail?: string | null,
  customerAddress?: string | null,
  language: 'en' | 'km' = 'en'
): string {
  if (language === 'km') {
    return formatOrderSummaryKhmer(items, total, customerName, customerPhone, customerEmail, customerAddress);
  }
  return formatOrderSummaryEnglish(items, total, customerName, customerPhone, customerEmail, customerAddress);
}

function formatOrderSummaryEnglish(
  items: OrderItem[],
  total: number,
  customerName?: string | null,
  customerPhone?: string | null,
  customerEmail?: string | null,
  customerAddress?: string | null
): string {
  const lines: string[] = [];
  
  lines.push('📋 **ORDER SUMMARY**');
  lines.push('');
  lines.push('**Items:**');
  
  items.forEach((item, index) => {
    const itemTotal = item.price * item.quantity;
    lines.push(`${index + 1}. ${item.productName}`);
    lines.push(`   Qty: ${item.quantity} × $${item.price.toFixed(2)} = $${itemTotal.toFixed(2)}`);
  });
  
  lines.push('');
  lines.push(`**Total: $${total.toFixed(2)}**`);
  lines.push('');
  lines.push('**Delivery Information:**');
  lines.push(`👤 Name: ${customerName || 'N/A'}`);
  lines.push(`📞 Phone: ${customerPhone || 'N/A'}`);
  if (customerEmail) {
    lines.push(`📧 Email: ${customerEmail}`);
  }
  lines.push(`📍 Address: ${customerAddress || 'N/A'}`);
  lines.push('');
  lines.push('Please review your order carefully.');
  lines.push('Reply with **YES** to confirm or **EDIT** to make changes.');
  
  return lines.join('\n');
}

function formatOrderSummaryKhmer(
  items: OrderItem[],
  total: number,
  customerName?: string | null,
  customerPhone?: string | null,
  customerEmail?: string | null,
  customerAddress?: string | null
): string {
  const lines: string[] = [];
  
  lines.push('📋 **សេចក្តីសង្ខេបការបញ្ជាទិញ**');
  lines.push('');
  lines.push('**ផលិតផល:**');
  
  items.forEach((item, index) => {
    const itemTotal = item.price * item.quantity;
    lines.push(`${index + 1}. ${item.productName}`);
    lines.push(`   បរិមាណ: ${item.quantity} × $${item.price.toFixed(2)} = $${itemTotal.toFixed(2)}`);
  });
  
  lines.push('');
  lines.push(`**សរុប: $${total.toFixed(2)}**`);
  lines.push('');
  lines.push('**ព័ត៌មានដឹកជញ្ជូន:**');
  lines.push(`👤 ឈ្មោះ: ${customerName || 'មិនមាន'}`);
  lines.push(`📞 លេខទូរស័ព្ទ: ${customerPhone || 'មិនមាន'}`);
  if (customerEmail) {
    lines.push(`📧 អ៊ីមែល: ${customerEmail}`);
  }
  lines.push(`📍 អាសយដ្ឋាន: ${customerAddress || 'មិនមាន'}`);
  lines.push('');
  lines.push('សូមពិនិត្យមើលការបញ្ជាទិញរបស់អ្នកដោយប្រុងប្រយ័ត្ន។');
  lines.push('ឆ្លើយតប **YES** ដើម្បីបញ្ជាក់ ឬ **EDIT** ដើម្បីកែប្រែ។');
  
  return lines.join('\n');
}

/**
 * Format existing customer info for reconfirmation
 */
export function formatCustomerInfoReconfirm(
  name: string,
  phone: string,
  email: string | null,
  address: string,
  language: 'en' | 'km' = 'en'
): string {
  if (language === 'km') {
    return formatCustomerInfoReconfirmKhmer(name, phone, email, address);
  }
  return formatCustomerInfoReconfirmEnglish(name, phone, email, address);
}

function formatCustomerInfoReconfirmEnglish(
  name: string,
  phone: string,
  email: string | null,
  address: string
): string {
  const lines: string[] = [];
  
  lines.push('✅ I found your saved information:');
  lines.push('');
  lines.push(`👤 Name: ${name}`);
  lines.push(`📞 Phone: ${phone}`);
  if (email) {
    lines.push(`📧 Email: ${email}`);
  }
  lines.push(`📍 Address: ${address}`);
  lines.push('');
  lines.push('Would you like to use this information?');
  lines.push('Reply **YES** to use it, or **UPDATE** to change it.');
  
  return lines.join('\n');
}

function formatCustomerInfoReconfirmKhmer(
  name: string,
  phone: string,
  email: string | null,
  address: string
): string {
  const lines: string[] = [];
  
  lines.push('✅ ខ្ញុំបានរកឃើញព័ត៌មានដែលបានរក្សាទុករបស់អ្នក:');
  lines.push('');
  lines.push(`👤 ឈ្មោះ: ${name}`);
  lines.push(`📞 លេខទូរស័ព្ទ: ${phone}`);
  if (email) {
    lines.push(`📧 អ៊ីមែល: ${email}`);
  }
  lines.push(`📍 អាសយដ្ឋាន: ${address}`);
  lines.push('');
  lines.push('តើអ្នកចង់ប្រើព័ត៌មាននេះទេ?');
  lines.push('ឆ្លើយតប **YES** ដើម្បីប្រើ ឬ **UPDATE** ដើម្បីកែប្រែ។');
  
  return lines.join('\n');
}

