import { z } from 'zod';

export const conversationStageSchema = z.enum([
  'ask_item',
  'ask_name',
  'ask_phone',
  'ask_email',
  'ask_address',
  'completed',
  'confirm_order',
  'processing_order'
]);

export const userMessageSchema = z.string().trim().max(800);

export const leadUpdateSchema = z.object({
  item: z.string().trim().max(200).optional().nullable(),
  name: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  stage: conversationStageSchema.optional(),
});

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return phone ?? null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return email ?? null;
  const [localName = '', domain = ''] = email.split('@');
  if (!domain) return '***@***';
  const maskedName = localName.length <= 2 ? '*'.repeat(localName.length) : `${localName[0]}***${localName[localName.length - 1]}`;
  return `${maskedName}@${domain}`;
}

// Helper to build Partial<LeadDoc> without undefined values
export function buildLeadUpdate(input: {
  item?: string | null | undefined;
  name?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
  stage?: 'ask_item' | 'ask_name' | 'ask_phone' | 'ask_email' | 'ask_address' | 'completed' | 'confirm_order' | 'processing_order' | undefined;
}): Partial<{ item: string | null; name: string | null; phone: string | null; email: string | null; address: string | null; stage: 'ask_item' | 'ask_name' | 'ask_phone' | 'ask_email' | 'ask_address' | 'completed' | 'confirm_order' | 'processing_order' }>
{
  const out: any = {};
  if (input.item !== undefined) out.item = input.item;
  if (input.name !== undefined) out.name = input.name;
  if (input.phone !== undefined) out.phone = input.phone;
  if (input.email !== undefined) out.email = input.email;
  if (input.address !== undefined) out.address = input.address;
  if (input.stage !== undefined) out.stage = input.stage;
  return out;
}


