-- Add last_shown_products column to leads table
-- This stores the products shown to the user in their last product query
-- Used when they confirm an order ("I'll take it") to know which product they're referring to

ALTER TABLE leads 
ADD COLUMN IF NOT EXISTS last_shown_products JSONB DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN leads.last_shown_products IS 'Products shown to user in last query, used for order confirmation';

