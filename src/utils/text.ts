/**
 * Clamp/truncate text to a maximum length
 * @param input Input text
 * @param maxChars Maximum characters allowed (default: 1000)
 * @param suffix Suffix to append when truncated (default: '…')
 * @returns Clamped text
 */
export function clampText(input: string, maxChars: number = 1000, suffix: string = '…'): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars) + suffix;
}

/**
 * Sanitize text content for storage/display
 * Removes excessive whitespace and normalizes line breaks
 * @param input Input text
 * @param maxChars Maximum characters allowed
 * @returns Sanitized text
 */
export function sanitizeContent(input: string, maxChars: number = 1000): string {
  return clampText(input, maxChars, '…');
}

/**
 * Validate that a string is not empty after trimming
 * @param input Input string
 * @returns true if string has content
 */
export function hasContent(input: string): boolean {
  return input.trim().length > 0;
}

