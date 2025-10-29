/**
 * Remove markdown formatting from text
 * Facebook Messenger doesn't support markdown, so we strip it out
 */
export function stripMarkdown(text: string): string {
  let cleaned = text;
  
  // Remove bold: **text** or *text* -> text
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  
  // Remove italic: _text_ or __text__ -> text
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
  
  // Remove strikethrough: ~~text~~ -> text
  cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');
  
  // Remove code: `text` -> text
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  
  return cleaned;
}

/**
 * Clean AI response for Messenger
 * Removes all markdown and formatting that Messenger doesn't support
 */
export function cleanAIResponse(response: string): string {
  return stripMarkdown(response);
}

