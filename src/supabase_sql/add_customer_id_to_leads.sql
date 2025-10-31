-- ====================================================
-- Add customer_id to leads table
-- ====================================================
-- This migration links leads to their customer records so that
-- when a customer updates their info, we update the existing
-- customer record instead of creating a new one

-- Add customer_id column to leads table
ALTER TABLE public.leads 
ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_leads_customer_id ON public.leads (customer_id);

-- Verify the column was added
SELECT 
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'leads' 
  AND column_name = 'customer_id';

