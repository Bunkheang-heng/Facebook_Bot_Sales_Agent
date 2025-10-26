import { supabase } from '../supabase';
import { env } from '../config';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../logger';

export type RetrievedProduct = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  size: string | null;
  price: number | null;
  image_url: string | null;
  similarity: number;
};

// Cache token to avoid 2s overhead on every request
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Return cached token if still valid (with 1min buffer)
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    logger.debug('Using cached access token');
    return cachedToken.token;
  }
  
  logger.info('Fetching new access token');
  const privateKey = env.GOOGLE_CLOUD_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\n/g, '\n');
  const auth = new GoogleAuth({
    credentials: { client_email: env.GOOGLE_CLOUD_CLIENT_EMAIL, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse || !tokenResponse.token) throw new Error('Failed to obtain Google access token');
  
  // Cache for 55 minutes (tokens expire in 1 hour)
  cachedToken = {
    token: tokenResponse.token,
    expiresAt: now + 3300000
  };
  
  return tokenResponse.token;
}

export async function embedTextWithVertex(text: string): Promise<number[]> {
  logger.info({ text: text.slice(0, 100) }, '🧠 Vertex AI: Generating text embedding');
  const token = await getAccessToken();
  // Using multimodalembedding@001 to match existing 1408-dim embeddings in Supabase
  const url = `https://${env.GOOGLE_CLOUD_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GOOGLE_CLOUD_PROJECT_ID}/locations/${env.GOOGLE_CLOUD_LOCATION}/publishers/google/models/multimodalembedding@001:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [
        {
          text: text
        }
      ]
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, error: errText, url }, '❌ Vertex AI: Text embedding failed');
    throw new Error(`Vertex embed error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const values: number[] | undefined = data?.predictions?.[0]?.textEmbedding;
  if (!values || !Array.isArray(values)) {
    logger.error({ response: JSON.stringify(data).slice(0, 500) }, '❌ Vertex AI: Invalid embedding response');
    throw new Error('Invalid embedding response');
  }
  logger.info({ dimension: values.length }, '✅ Vertex AI: Text embedding generated');
  return values.map((v: any) => Number(v));
}

/**
 * Generate embeddings from image using Vertex AI multimodal model
 * @param imageBase64 Base64 encoded image data
 * @returns 1408-dimensional embedding vector
 */
export async function embedImageWithVertex(imageBase64: string): Promise<number[]> {
  logger.info({ imageSize: Math.round(imageBase64.length / 1024) + 'KB' }, '🖼️ Vertex AI: Generating image embedding');
  const token = await getAccessToken();
  
  const url = `https://${env.GOOGLE_CLOUD_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GOOGLE_CLOUD_PROJECT_ID}/locations/${env.GOOGLE_CLOUD_LOCATION}/publishers/google/models/multimodalembedding@001:predict`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [
        {
          image: {
            bytesBase64Encoded: imageBase64
          }
        }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, error: errText }, '❌ Vertex AI: Image embedding failed');
    throw new Error(`Vertex image embed error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const values: number[] | undefined = data?.predictions?.[0]?.imageEmbedding;
  
  if (!values || !Array.isArray(values)) {
    logger.error({ response: JSON.stringify(data).slice(0, 500) }, '❌ Vertex AI: Invalid image embedding response');
    throw new Error('Invalid image embedding response');
  }

  logger.info({ dimension: values.length }, '✅ Vertex AI: Image embedding generated');
  return values.map((v: any) => Number(v));
}

export async function retrieveSimilarContext(queryText: string, opts?: { matchCount?: number; minSimilarity?: number }): Promise<RetrievedProduct[]> {
  const queryEmbedding = await embedTextWithVertex(queryText);
  // For recommendation queries, fetch more products (up to 10)
  const defaultCount = queryText.toLowerCase().includes('recommend') || 
                       queryText.toLowerCase().includes('show') ||
                       queryText.toLowerCase().includes('options') ? 10 : env.RAG_MATCH_COUNT;
  const matchCount = Math.max(1, opts?.matchCount ?? defaultCount);
  const matchThreshold = Math.max(0, Math.min(1, opts?.minSimilarity ?? env.RAG_MIN_SIMILARITY));

  logger.info(
    { 
      query: queryText, 
      matchCount, 
      matchThreshold, 
      embeddingDim: queryEmbedding.length,
      filterByTenant: env.PRODUCT_TENANT_ID || 'none'
    },
    '🔎 Supabase: Querying hybrid + vector search (text)'
  );

  // Build RPC params with optional tenant filter
  const rpcParams: any = {
    query_text: queryText,
    query_embedding: queryEmbedding,
    match_threshold: matchThreshold,
    match_count: matchCount
  };

  // Add tenant_id filter if configured
  if (env.PRODUCT_TENANT_ID) {
    rpcParams.filter_tenant_id = env.PRODUCT_TENANT_ID;
  }

  // Parallel search with DIFFERENT thresholds (matching Next.js implementation)
  const [{ data: hybrid, error: e1 }, { data: vec, error: e2 }] = await Promise.all([
    supabase.rpc(env.SUPABASE_MATCH_TEXT_FN, {
      ...rpcParams,
      match_threshold: 0.2,  // Lenient for hybrid search
      match_count: 10  // Fetch 10 from each method
    }),
    supabase.rpc(env.SUPABASE_MATCH_EMBEDDING_FN, {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,  // Slightly stricter for vector-only
      match_count: 10,  // Fetch 10 from each method
      ...(env.PRODUCT_TENANT_ID ? { filter_tenant_id: env.PRODUCT_TENANT_ID } : {})
    })
  ]);

  if (e1) {
    logger.error({ error: e1, query: queryText.slice(0, 50) }, '❌ RAG TEXT SEARCH FAILED (Hybrid)');
    throw e1;
  }
  if (e2) {
    logger.error({ error: e2, query: queryText.slice(0, 50) }, '❌ RAG TEXT SEARCH FAILED (Vector)');
    throw e2;
  }

  logger.info(
    { hybridResults: hybrid?.length ?? 0, vectorResults: vec?.length ?? 0 },
    '📊 Supabase: Search results received'
  );

  // Merge and deduplicate: keep highest similarity per product ID
  const merged = [...(hybrid ?? []), ...(vec ?? [])];
  const byId = new Map<string, any>();
  for (const item of merged) {
    if (!item) continue;
    const prev = byId.get(item.id);
    if (!prev || (item.similarity ?? 0) > (prev.similarity ?? 0)) byId.set(item.id, item);
  }
  
  // Sort by similarity desc, take top N (matchCount from opts, or defaultCount based on query)
  const rows = Array.from(byId.values())
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, matchCount);  // This respects the dynamic count from opts or query analysis

  logger.info(
    {
      mergedCount: byId.size,
      finalCount: rows.length,
      topResults: rows.slice(0, 3).map((r) => ({ id: r.id, name: r.name, similarity: r.similarity }))
    },
    '✅ Supabase: Results merged and ranked'
  );

  const products = rows.map((r: any) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    description: r.description ?? null,
    price: r.price == null ? null : Number(r.price),
    image_url: r.image_url ?? null,
    category: r.category ?? null,
    size: r.size ?? null,
    similarity: Number(r.similarity ?? 0)
  }));

  // Final success/failure summary
  if (products.length > 0) {
    const bestProduct = products[0]!; // Safe: length > 0
    logger.info(
      { 
        query: queryText.slice(0, 50),
        productCount: products.length,
        bestMatch: bestProduct.name,
        bestSimilarity: bestProduct.similarity.toFixed(3),
        tenantFilter: env.PRODUCT_TENANT_ID || 'none'
      },
      '✅ RAG TEXT SEARCH SUCCESS'
    );
  } else {
    logger.warn(
      { 
        query: queryText.slice(0, 50),
        tenantFilter: env.PRODUCT_TENANT_ID || 'none'
      },
      '⚠️ RAG TEXT SEARCH: NO RESULTS'
    );
  }

  return products;
}

/**
 * Retrieve similar products using image-based vector search
 * @param imageBase64 Base64 encoded image
 * @param opts Optional match count and similarity threshold
 * @returns Array of similar products
 */
export async function retrieveSimilarContextByImage(
  imageBase64: string,
  opts?: { matchCount?: number; minSimilarity?: number }
): Promise<RetrievedProduct[]> {
  const queryEmbedding = await embedImageWithVertex(imageBase64);
  const matchCount = Math.max(1, opts?.matchCount ?? env.RAG_MATCH_COUNT);
  const matchThreshold = Math.max(0, Math.min(1, opts?.minSimilarity ?? env.RAG_MIN_SIMILARITY));

  logger.info(
    { 
      matchCount, 
      matchThreshold, 
      embeddingDim: queryEmbedding.length,
      filterByTenant: env.PRODUCT_TENANT_ID || 'none'
    },
    '🔎 Supabase: Querying vector search (image)'
  );

  // Build RPC params with optional tenant filter
  const rpcParams: any = {
    query_embedding: queryEmbedding,
    match_threshold: matchThreshold,
    match_count: matchCount
  };

  // Add tenant_id filter if configured
  if (env.PRODUCT_TENANT_ID) {
    rpcParams.filter_tenant_id = env.PRODUCT_TENANT_ID;
  }

  // Image search uses pure vector similarity (no text/hybrid)
  const { data: vec, error } = await supabase.rpc(env.SUPABASE_MATCH_EMBEDDING_FN, rpcParams);

  if (error) {
    logger.error({ error }, '❌ RAG IMAGE SEARCH FAILED');
    throw error;
  }

  logger.info(
    { vectorResults: vec?.length ?? 0 },
    '📊 Supabase: Image search results received'
  );

  const rows = (vec ?? [])
    .sort((a: any, b: any) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, matchCount);

  logger.info(
    {
      finalCount: rows.length,
      topResults: rows.slice(0, 3).map((r: any) => ({ id: r.id, name: r.name, similarity: r.similarity }))
    },
    '✅ Supabase: Image search results ranked'
  );

  const products = rows.map((r: any) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    description: r.description ?? null,
    price: r.price == null ? null : Number(r.price),
    image_url: r.image_url ?? null,
    category: r.category ?? null,
    size: r.size ?? null,
    similarity: Number(r.similarity ?? 0)
  }));

  // Final success/failure summary
  if (products.length > 0) {
    const bestProduct = products[0]!; // Safe: length > 0
    logger.info(
      { 
        productCount: products.length,
        bestMatch: bestProduct.name,
        bestSimilarity: bestProduct.similarity.toFixed(3),
        tenantFilter: env.PRODUCT_TENANT_ID || 'none'
      },
      '✅ RAG IMAGE SEARCH SUCCESS'
    );
  } else {
    logger.warn(
      { 
        tenantFilter: env.PRODUCT_TENANT_ID || 'none'
      },
      '⚠️ RAG IMAGE SEARCH: NO RESULTS'
    );
  }

  return products;
}

export function buildRagContext(products: RetrievedProduct[], maxChars = 2000): string {
  if (!products.length) return '';
  const header = 'Retrieved products (semantic + keyword matches):\n';
  const body = products
    .sort((a, b) => b.similarity - a.similarity)
    .map((p, idx) => {
      const price = p.price == null ? '' : `\nPrice: $${p.price}`;
      const category = p.category ? `\nCategory: ${p.category}` : '';
      const size = p.size ? `\nSize: ${p.size}` : '';
      const img = p.image_url ? `\nImage: ${p.image_url}` : '';
      const desc = (p.description ?? '').toString().trim();
      const descSnippet = desc.length > 500 ? desc.slice(0, 500) + '…' : desc;
      return `#${idx + 1} (sim=${p.similarity.toFixed(3)})\nName: ${p.name}${price}${category}${size}${img}\nDescription: ${descSnippet}`;
    })
    .join('\n\n');
  const text = (header + body).slice(0, maxChars);
  return text;
}