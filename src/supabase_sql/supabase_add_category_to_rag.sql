-- ==========================================
-- Add category support for improved RAG accuracy
-- ==========================================

-- Step 1: Re-add the text category column (for simple queries)
-- This makes it easier to filter without complex joins
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;

-- Step 2: Populate category from category_id (if using foreign key)
UPDATE products p
SET category = pc.name
FROM product_categories pc
WHERE p.category_id = pc.id AND p.category IS NULL;

-- Step 3: Drop existing functions first (required when changing return types)
DROP FUNCTION IF EXISTS search_products_by_embedding(vector, double precision, integer, text);
DROP FUNCTION IF EXISTS search_products_by_embedding(vector, float, integer, text);

-- Step 3: Create/Update RPC function for embedding search with category
CREATE OR REPLACE FUNCTION search_products_by_embedding(
  query_embedding vector(1408),
  match_threshold float DEFAULT 0,
  match_count int DEFAULT 5,
  filter_tenant_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  price numeric,
  image_url text,
  category text,  -- ✅ Now returns category
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.description,
    p.price,
    p.image_url,
    p.category,  -- ✅ Include category
    1 - (p.embedding <=> query_embedding) as similarity
  FROM products p
  WHERE 
    (p.embedding <=> query_embedding) < (1 - match_threshold)
    AND (filter_tenant_id IS NULL OR p.tenant_id::text = filter_tenant_id)
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Step 4: Drop existing hybrid function first
DROP FUNCTION IF EXISTS search_products_hybrid_text(text, vector, double precision, integer, text);
DROP FUNCTION IF EXISTS search_products_hybrid_text(text, vector, float, integer, text);

-- Step 4: Create/Update RPC function for hybrid text+vector search with category
CREATE OR REPLACE FUNCTION search_products_hybrid_text(
  query_text text,
  query_embedding vector(1408),
  match_threshold float DEFAULT 0,
  match_count int DEFAULT 5,
  filter_tenant_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  price numeric,
  image_url text,
  category text,  -- ✅ Now returns category
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.description,
    p.price,
    p.image_url,
    p.category,  -- ✅ Include category
    (
      -- Combine text search (40%) and vector similarity (60%)
      (0.4 * ts_rank_cd(p.search_tsv, plainto_tsquery('simple', query_text))) +
      (0.6 * (1 - (p.embedding <=> query_embedding)))
    ) as similarity
  FROM products p
  WHERE 
    (
      p.search_tsv @@ plainto_tsquery('simple', query_text)
      OR (p.embedding <=> query_embedding) < (1 - match_threshold)
    )
    AND (filter_tenant_id IS NULL OR p.tenant_id::text = filter_tenant_id)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- Step 5: Add index on category for faster filtering
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- Step 6: Add comment for documentation
COMMENT ON COLUMN products.category IS 'Product category (text) for RAG filtering and accuracy';

-- ✅ Done! Your RPC functions now return category for smart filtering

