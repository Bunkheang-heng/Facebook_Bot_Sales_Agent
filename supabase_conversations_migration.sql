-- ====================================================
-- Conversation & Lead Management Tables for Supabase
-- ====================================================
-- Replaces Firebase for storing conversation state and chat history

-- ====================================================
-- 1. Leads/Conversation State Table
-- ====================================================
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE, -- Facebook user ID
  tenant_id uuid REFERENCES public.tenants(id),
  
  -- Lead information
  item text,
  name text,
  phone text,
  email text,
  address text,
  
  -- Conversation stage
  stage text NOT NULL DEFAULT 'ask_item' 
    CHECK (stage IN ('ask_item', 'ask_name', 'ask_phone', 'ask_email', 'ask_address', 'completed', 'confirm_order', 'processing_order')),
  
  -- Pending order (JSONB for flexibility)
  pending_order jsonb, -- { items: [...], total: number }
  last_order_id uuid REFERENCES public.orders(id),
  
  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookup by user_id
CREATE INDEX IF NOT EXISTS idx_leads_user_id ON public.leads (user_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON public.leads (tenant_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_leads_updated_at ON public.leads;
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Auto-set tenant_id on insert
DROP TRIGGER IF EXISTS trg_leads_set_tenant ON public.leads;
CREATE TRIGGER trg_leads_set_tenant
  BEFORE INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_tenant_id_generic();

-- ====================================================
-- 2. Chat History Table
-- ====================================================
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL, -- Facebook user ID
  tenant_id uuid REFERENCES public.tenants(id),
  
  -- Message content
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  
  -- Metadata
  message_id text, -- Facebook message ID (if available)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON public.chat_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant ON public.chat_messages (tenant_id);

-- Auto-set tenant_id on insert
DROP TRIGGER IF EXISTS trg_chat_messages_set_tenant ON public.chat_messages;
CREATE TRIGGER trg_chat_messages_set_tenant
  BEFORE INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_tenant_id_generic();

-- ====================================================
-- 3. Conversation Summaries Table (for context compression)
-- ====================================================
CREATE TABLE IF NOT EXISTS public.conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE, -- Facebook user ID
  tenant_id uuid REFERENCES public.tenants(id),
  
  -- Summary content
  summary text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  
  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_user_id ON public.conversation_summaries (user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_tenant ON public.conversation_summaries (tenant_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_conversation_summaries_updated_at ON public.conversation_summaries;
CREATE TRIGGER trg_conversation_summaries_updated_at
  BEFORE UPDATE ON public.conversation_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Auto-set tenant_id on insert
DROP TRIGGER IF EXISTS trg_conversation_summaries_set_tenant ON public.conversation_summaries;
CREATE TRIGGER trg_conversation_summaries_set_tenant
  BEFORE INSERT ON public.conversation_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_tenant_id_generic();

-- ====================================================
-- 4. RLS Policies
-- ====================================================

-- Leads
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_select ON public.leads;
CREATE POLICY leads_select ON public.leads FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = leads.tenant_id)
);

DROP POLICY IF EXISTS leads_all ON public.leads;
CREATE POLICY leads_all ON public.leads FOR ALL USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = leads.tenant_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = leads.tenant_id)
);

-- Chat Messages
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_messages_select ON public.chat_messages;
CREATE POLICY chat_messages_select ON public.chat_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = chat_messages.tenant_id)
);

DROP POLICY IF EXISTS chat_messages_all ON public.chat_messages;
CREATE POLICY chat_messages_all ON public.chat_messages FOR ALL USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = chat_messages.tenant_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = chat_messages.tenant_id)
);

-- Conversation Summaries
ALTER TABLE public.conversation_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_summaries_select ON public.conversation_summaries;
CREATE POLICY conversation_summaries_select ON public.conversation_summaries FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = conversation_summaries.tenant_id)
);

DROP POLICY IF EXISTS conversation_summaries_all ON public.conversation_summaries;
CREATE POLICY conversation_summaries_all ON public.conversation_summaries FOR ALL USING (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = conversation_summaries.tenant_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = auth.uid() AND ut.tenant_id = conversation_summaries.tenant_id)
);

-- ====================================================
-- 5. Helper Functions
-- ====================================================

-- Get recent chat messages for a user
CREATE OR REPLACE FUNCTION public.get_chat_history(
  p_user_id text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  role text,
  content text,
  message_id text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, role, content, message_id, created_at
  FROM public.chat_messages
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;

-- Verify tables exist
SELECT 
  table_name,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public' 
  AND table_name IN ('leads', 'chat_messages', 'conversation_summaries')
ORDER BY table_name;

