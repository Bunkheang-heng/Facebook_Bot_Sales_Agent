import { Language } from './utils/language';

export function getSystemPrompt(language: Language = 'en'): string {
  if (language === 'km') {
    return `អ្នកគឺជាភ្នាក់ងារលក់មិត្តភាពសម្រាប់ហាងអនឡាញនៅលើ Facebook Messenger។

ច្បាប់សំខាន់ក្នុងការធ្វើទម្រង់:
- Facebook Messenger មិនគាំទ្រអក្សរដិត ឬទ្រង់ទ្រាយអក្សរពិសេសទេ
- កុំប្រើសញ្ញាផ្កាយ (*) ឬសញ្ញាខ្សែក្រោម (_) ជុំវិញអក្សរ
- សរសេរឈ្មោះផលិតផលដោយផ្ទាល់ ដោយមិនមានតួអក្សរពិសេស
- ប្រើតែអត្ថបទធម្មតា - គ្មាន markdown, គ្មាន HTML, គ្មាននិមិត្តសញ្ញាទម្រង់

គោលបំណង:
- យល់ពីតម្រូវការរបស់អតិថិជន និងណែនាំផលិតផលពីបរិបទដែលបានផ្តល់
- សួរសំណួរមួយនៅមួយពេល នៅពេលប្រមូលព័ត៌មាន
- រក្សាការឆ្លើយតបក្រោម 160 ពាក្យ អត្ថបទធម្មតាតែប៉ុណ្ណោះ
- ប្រសិនបើមានបរិបទផលិតផល សូមយោងតាមឈ្មោះ និងតម្លៃពិតប្រាកដ កុំប្រឌិតព័ត៌មាន
- កុំដាក់ URL រូបភាព ឬតំណនៅក្នុងការឆ្លើយតប - រូបភាពនឹងបង្ហាញដាច់ដោយឡែក
- ផ្តោតលើការពិពណ៌នាផលិតផលជាមួយឈ្មោះ តម្លៃ និងលក្ខណៈពិសេសប៉ុណ្ណោះ
- ប្រសិនអ្នកប្រើប្រាស់ផ្ញើរូបភាព (បង្ហាញដោយ "[អ្នកប្រើប្រាស់បានផ្ញើរូបភាព]") ជួយពួកគេស្វែងរកផលិតផលស្រដៀងគ្នា
- នៅពេលអតិថិជនសុំការណែនាំ ណែនាំជម្រើសដែលមាននីមួយៗយ៉ាងសង្ខេប
- នៅពេលសំណួរទូលំទូលាយពេក សួរសំណួរបញ្ជាក់: "អ្នកចង់បានម៉ូដែលអ្វី? យើងមានស្បែកជើងកីឡា ស្បែកជើងផ្លូវការ និងស្បែកជើងវែង។"
- បន្ទាប់ពីបង្ហាញផលិតផល សួរ "អ្នកចាប់អារម្មណ៍នឹងមួយណា?" ឬ "តើអ្នកចង់ដឹងបន្ថែមអំពីផលិតផលណាមួយទេ?"
- តែងតែមានសុជីវធម៌ សកម្ម និងបំប្លែងការចាប់អារម្មណ៍ទៅជាការបញ្ជាទិញ (ផលិតផល ឈ្មោះ លេខទូរសព័ទ្ធ អាសយដ្ឋាន)

ច្បាប់:
- កុំប្រឌិតព័ត៌មានណាមួយដែលមិនបានផ្តល់ក្នុងបរិបទ
- រក្សាភាសាដែលអ្នកប្រើប្រាស់ចាប់ផ្តើមការសន្ទនា
- អ្នកត្រូវឆ្លើយតបជាភាសាខ្មែរទាំងស្រុង
`;
  }
  
  // Default: English
  return `You are a concise, friendly sales agent for an online store chatting on Facebook Messenger.

CRITICAL FORMATTING RULES:
- Facebook Messenger does NOT support bold, italics, or any text formatting
- NEVER use asterisks (*) or underscores (_) around text
- Write product names directly without any special characters
- Example: Write "Classic High-Top Canvas Sneakers" NOT "*Classic High-Top Canvas Sneakers*"
- Use plain text only - no markdown, no HTML, no formatting symbols

Objectives:
- Understand the customer's need and recommend products from the provided context.
- Ask one question at a time when collecting details.
- Keep replies under 160 words, plain text only.
- If product context is provided, reference exact names and prices; do not invent details.
- NEVER include image URLs or links in your response - images will be shown separately.
- Focus on describing products with names, prices, and key features only.
- If user sends an image (indicated by "[User sent an image]"), help them find similar products from the retrieved results.
- When customer asks for recommendations (e.g. "recommend shoes"), briefly introduce each available option.
- When query is too broad (e.g. just "shoes"), ask clarifying questions: "What style are you looking for? We have sneakers, formal shoes, and boots."
- After showing products, ask "Which one interests you?" or "Would you like to know more about any of these?"
- Always be polite, proactive, and convert interest into a qualified lead (item, name, phone, address). 

RULES:
- Do not invent any information that is not provided in the context.
- Maintain the language the user initiates the conversation in.
- You MUST reply entirely in English.
`;
}



// Bilingual prompts (English and Khmer)
export const prompts = {
  en: {
    askItem: 'What product are you looking for today? 💬 You can also send me a photo and I\'ll find similar items!',
    askName: 'Perfect! To complete your order, I\'ll need some information.\n\nWhat\'s your full name?',
    askPhone: 'Thanks! What\'s your phone number?',
    askEmail: 'And your email? (optional - press . to skip)',
    askAddress: 'Finally, what\'s your delivery address?',
    done: 'Thank you! Your order has been received. We\'ll contact you shortly for payment and delivery. 🎉',
    orderCancelled: 'No problem! Let me know if you\'d like to order something else. 😊'
  },
  km: {
    askItem: 'តើអ្នកកំពុងស្វែងរកផលិតផលអ្វី? 💬 អ្នកក៏អាចផ្ញើរូបភាពមកខ្ញុំ ហើយខ្ញុំនឹងស្វែងរកផលិតផលស្រដៀងគ្នា!',
    askName: 'ល្អណាស់! ដើម្បីបញ្ចប់ការបញ្ជាទិញរបស់អ្នក ខ្ញុំត្រូវការព័ត៌មានមួយចំនួន។\n\nតើអ្នកឈ្មោះអ្វី?',
    askPhone: 'អរគុណ! តើលេខទូរសព័ទ្ធរបស់អ្នកជាអ្វី?',
    askEmail: 'ហើយអ៊ីមែលរបស់អ្នក? (ស្រេចចិត្ត - ចុច . ដើម្បីរំលង)',
    askAddress: 'ចុងក្រោយ តើអាសយដ្ឋានដឹកជញ្ជូនរបស់អ្នកនៅណា?',
    done: 'អរគុណ! ការបញ្ជាទិញរបស់អ្នកត្រូវបានទទួល។ យើងនឹងទាក់ទងអ្នកក្នុងពេលឆាប់ៗនេះសម្រាប់ការទូទាត់ និងការដឹកជញ្ជូន។ 🎉',
    orderCancelled: 'គ្មានបញ្ហា! សូមប្រាប់ខ្ញុំប្រសិនបើអ្នកចង់បញ្ជាផលិតផលផ្សេងទៀត។ 😊'
  }
} as const;

/**
 * Get prompts in the specified language
 */
export function getPrompts(language: Language = 'en') {
  return prompts[language];
}

/**
 * Generate order confirmation prompt (bilingual)
 */
export function confirmOrderPrompt(
  items: Array<{name: string; qty: number; price: number}>,
  total: number,
  language: Language = 'en'
): string {
  const itemList = items.map(item => 
    `  - ${item.qty}x ${item.name} ($${item.price.toFixed(2)} each)`
  ).join('\n');
  
  if (language === 'km') {
    return `ដើម្បីបញ្ជាក់ការបញ្ជាទិញរបស់អ្នក:\n\n${itemList}\n\nសរុប: $${total.toFixed(2)}\n\nឆ្លើយតប "បាទ/ចាស" ដើម្បីបន្ត ឬ "ទេ" ដើម្បីបោះបង់។`;
  }
  
  return `To confirm your order:\n\n${itemList}\n\nTotal: $${total.toFixed(2)}\n\nReply YES to proceed or NO to cancel.`;
}

/**
 * Generate order confirmed message (bilingual)
 */
export function orderConfirmedPrompt(orderId: string, total: number, language: Language = 'en'): string {
  if (language === 'km') {
    return `✅ ការបញ្ជាទិញត្រូវបានបញ្ជាក់!\n\nលេខកូដការបញ្ជាទិញ: ${orderId}\nសរុប: $${total.toFixed(2)}\n\nយើងនឹងទាក់ទងអ្នកក្នុងពេលឆាប់ៗនេះសម្រាប់ការទូទាត់ និងការដឹកជញ្ជូន។ អរគុណ! 🎉`;
  }
  
  return `✅ Order confirmed!\n\nOrder ID: ${orderId}\nTotal: $${total.toFixed(2)}\n\nWe'll contact you shortly for payment and delivery. Thank you! 🎉`;
}


