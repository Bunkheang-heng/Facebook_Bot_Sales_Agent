-- ====================================================
-- Add 'show_order_summary' stage to leads table
-- ====================================================
-- This migration adds the new 'show_order_summary' conversation stage
-- which is used to display the order summary before final confirmation

-- Drop the existing constraint
ALTER TABLE public.leads 
DROP CONSTRAINT IF EXISTS leads_stage_check;

-- Add the new constraint with 'show_order_summary' included
ALTER TABLE public.leads 
ADD CONSTRAINT leads_stage_check 
CHECK (stage IN (
  'ask_item', 
  'ask_name', 
  'ask_phone', 
  'ask_email', 
  'ask_address', 
  'completed', 
  'show_order_summary',  -- NEW STAGE
  'confirm_order', 
  'processing_order'
));

-- Verify the constraint was updated
SELECT 
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conname = 'leads_stage_check';

