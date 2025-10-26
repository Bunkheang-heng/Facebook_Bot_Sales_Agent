-- ========================================
-- ADD TENANT FILTERING TO RAG FUNCTIONS
-- ========================================
-- This migration updates the search_products_* functions to support optional tenant filtering
-- Run this in Supabase SQL Editor

-- 1. DROP existing functions first (to avoid "cannot change return type" error)
DROP FUNCTION IF EXISTS public.search_products_by_embedding(vector, double precision, integer, text);
DROP FUNCTION IF EXISTS public.search_products_by_embedding(vector, double precision, integer);
DROP FUNCTION IF EXISTS public.search_products_hybrid_text(text, vector, double precision, integer, text);
DROP FUNCTION IF EXISTS public.search_products_hybrid_text(text, vector, double precision, integer);

-- 2. CREATE search_products_by_embedding WITH tenant filtering
CREATE OR REPLACE FUNCTION public.search_products_by_embedding(
  query_embedding vector(1408),
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 5,
  filter_tenant_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  name text,
  description text,
  category text,
  size text,
  price numeric,
  image_url text,
  similarity double precision
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id::text,
    p.name,
    p.description,
    p.category,
    p.size,
    p.price,
    p.image_url,
    (1 - (p.embedding <=> query_embedding))::double precision AS similarity
  FROM public.products p
  WHERE 
    (1 - (p.embedding <=> query_embedding)) >= match_threshold
    AND (filter_tenant_id IS NULL OR p.tenant_id::text = filter_tenant_id)
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 3. CREATE search_products_hybrid_text WITH tenant filtering
CREATE OR REPLACE FUNCTION public.search_products_hybrid_text(
  query_text text,
  query_embedding vector(1408),
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 5,
  filter_tenant_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  name text,
  description text,
  category text,
  size text,
  price numeric,
  image_url text,
  similarity double precision
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id::text,
    p.name,
    p.description,
    p.category,
    p.size,
    p.price,
    p.image_url,
    (
      -- 70% vector similarity + 30% text similarity
      0.7 * (1 - (p.embedding <=> query_embedding)) +
      0.3 * (
        CASE
          WHEN query_text = '' THEN 0
          ELSE ts_rank_cd(
            to_tsvector('english', coalesce(p.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.category, '')),
            plainto_tsquery('english', query_text)
          )
        END
      )
    )::double precision AS similarity
  FROM public.products p
  WHERE 
    (
      -- Vector similarity OR text match
      (1 - (p.embedding <=> query_embedding)) >= match_threshold
      OR (
        query_text <> '' AND
        to_tsvector('english', coalesce(p.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.category, ''))
        @@ plainto_tsquery('english', query_text)
      )
    )
    AND (filter_tenant_id IS NULL OR p.tenant_id::text = filter_tenant_id)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

-- 4. Grant execute permissions
GRANT EXECUTE ON FUNCTION public.search_products_by_embedding TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_products_hybrid_text TO authenticated;

-- ========================================
-- VERIFICATION QUERIES (optional, run to test)
-- ========================================
-- Test vector search without tenant filter:
-- SELECT * FROM search_products_by_embedding(
--   (SELECT embedding FROM products LIMIT 1),
--   0.3,
--   5,
--   NULL
-- );

-- Test vector search WITH tenant filter:
-- SELECT * FROM search_products_by_embedding(
--   (SELECT embedding FROM products LIMIT 1),
--   0.3,
--   5,
--   'your-tenant-id-here'
-- );

