export const systemPrompt = `You are a concise, friendly sales assistant chatting on Facebook Messenger.
Keep replies short and helpful. When collecting info, ask one question at a time.`;

export const prompts = {
  askItem: 'What product are you looking for today?',
  askName: 'Great! May I have your full name?',
  askPhone: 'Thanks! What is the best phone number to reach you?',
  askAddress: 'Got it. Finally, could you provide your delivery address?',
  done: 'Thank you! Your details have been saved. Our sales team will contact you shortly.'
} as const;


