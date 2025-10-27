import { supabase } from '../supabase';
import { env } from '../config';
import { logger } from '../logger';
import { ChatMessage } from '../types/domain';

export async function saveUserMessage(userId: string, content: string, messageId?: string): Promise<void> {
  const tenantId = env.PRODUCT_TENANT_ID;

  const { error } = await supabase
    .from('chat_messages')
    .insert({
      user_id: userId,
      role: 'user',
      content,
      message_id: messageId,
      tenant_id: tenantId
    });

  if (error) {
    logger.error({ error, userId }, 'Failed to save user message');
  }
}

export async function saveAssistantMessage(
  userId: string,
  content: string,
  messageId?: string
): Promise<void> {
  const tenantId = env.PRODUCT_TENANT_ID;

  const { error } = await supabase
    .from('chat_messages')
    .insert({
      user_id: userId,
      role: 'assistant',
      content,
      message_id: messageId,
      tenant_id: tenantId
    });

  if (error) {
    logger.error({ error, userId }, 'Failed to save assistant message');
  }
}

export async function getChatHistory(
  userId: string,
  limit: number = 20
): Promise<ChatMessage[]> {
  const tenantId = env.PRODUCT_TENANT_ID;

  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, userId }, 'Failed to fetch chat history');
    return [];
  }

  return (data || []).map(msg => ({
    id: msg.id,
    userId: msg.user_id,
    role: msg.role,
    content: msg.content,
    messageId: msg.message_id,
    createdAt: msg.created_at
  }));
}

export async function getConversationSummary(userId: string): Promise<string | null> {
  const tenantId = env.PRODUCT_TENANT_ID;

  const { data, error } = await supabase
    .from('conversation_summaries')
    .select('summary')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    return null;
  }

  return data.summary;
}

export async function updateConversationSummary(
  userId: string,
  summary: string,
  messageCount: number
): Promise<void> {
  const tenantId = env.PRODUCT_TENANT_ID;

  const { error } = await supabase
    .from('conversation_summaries')
    .upsert({
      user_id: userId,
      summary,
      message_count: messageCount,
      tenant_id: tenantId
    }, {
      onConflict: 'user_id'
    });

  if (error) {
    logger.error({ error, userId }, 'Failed to update conversation summary');
  }
}

