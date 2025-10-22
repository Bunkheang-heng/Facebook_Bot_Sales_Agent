import { supabase } from '../supabase';
import { env } from '../config';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../logger';

export type RetrievedProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  image_url: string | null;
  similarity: number;
};

async function getAccessToken(): Promise<string> {
  const privateKey = env.GOOGLE_CLOUD_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\n/g, '\n');
  const auth = new GoogleAuth({
    credentials: { client_email: env.GOOGLE_CLOUD_CLIENT_EMAIL, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('Failed to obtain Google access token');
  return token.token;
}

export async function embedTextWithVertex(text: string): Promise<number[]> {
  logger.info({ text: text.slice(0, 100) }, '🧠 Vertex AI: Generating embedding');
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
    logger.error({ status: res.status, error: errText, url }, '❌ Vertex AI: Embedding failed');
    throw new Error(`Vertex embed error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const values: number[] | undefined = data?.predictions?.[0]?.textEmbedding;
  if (!values || !Array.isArray(values)) {
    logger.error({ response: JSON.stringify(data).slice(0, 500) }, '❌ Vertex AI: Invalid embedding response');
    throw new Error('Invalid embedding response');
  }
  logger.info({ dimension: values.length }, '✅ Vertex AI: Embedding generated');
  return values.map((v: any) => Number(v));
}

export async function retrieveSimilarContext(queryText: string, opts?: { matchCount?: number; minSimilarity?: number }): Promise<RetrievedProduct[]> {
  const queryEmbedding = await embedTextWithVertex(queryText);
  const matchCount = Math.max(1, opts?.matchCount ?? env.RAG_MATCH_COUNT);
  const matchThreshold = Math.max(0, Math.min(1, opts?.minSimilarity ?? env.RAG_MIN_SIMILARITY));

  logger.info(
    { query: queryText, matchCount, matchThreshold, embeddingDim: queryEmbedding.length },
    '🔎 Supabase: Querying hybrid + vector search'
  );

  const [{ data: hybrid, error: e1 }, { data: vec, error: e2 }] = await Promise.all([
    supabase.rpc(env.SUPABASE_MATCH_TEXT_FN, {
      query_text: queryText,
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount
    }),
    supabase.rpc(env.SUPABASE_MATCH_EMBEDDING_FN, {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount
    })
  ]);

  if (e1) {
    logger.error({ error: e1 }, '❌ Supabase: Hybrid search failed');
    throw e1;
  }
  if (e2) {
    logger.error({ error: e2 }, '❌ Supabase: Vector search failed');
    throw e2;
  }

  logger.info(
    { hybridResults: hybrid?.length ?? 0, vectorResults: vec?.length ?? 0 },
    '📊 Supabase: Search results received'
  );

  const merged = [...(hybrid ?? []), ...(vec ?? [])];
  const byId = new Map<string, any>();
  for (const item of merged) {
    if (!item) continue;
    const prev = byId.get(item.id);
    if (!prev || (item.similarity ?? 0) > (prev.similarity ?? 0)) byId.set(item.id, item);
  }
  const rows = Array.from(byId.values())
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, matchCount);

  logger.info(
    {
      mergedCount: byId.size,
      finalCount: rows.length,
      topResults: rows.slice(0, 3).map((r) => ({ id: r.id, name: r.name, similarity: r.similarity }))
    },
    '✅ Supabase: Results merged and ranked'
  );

  return rows.map((r: any) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    description: r.description ?? null,
    price: r.price == null ? null : Number(r.price),
    image_url: r.image_url ?? null,
    similarity: Number(r.similarity ?? 0)
  }));
}

export function buildRagContext(products: RetrievedProduct[], maxChars = 2000): string {
  if (!products.length) return '';
  const header = 'Retrieved products (semantic + keyword matches):\n';
  const body = products
    .sort((a, b) => b.similarity - a.similarity)
    .map((p, idx) => {
      const price = p.price == null ? '' : `\nPrice: $${p.price}`;
      const img = p.image_url ? `\nImage: ${p.image_url}` : '';
      const desc = (p.description ?? '').toString().trim();
      const descSnippet = desc.length > 500 ? desc.slice(0, 500) + '…' : desc;
      return `#${idx + 1} (sim=${p.similarity.toFixed(3)})\nName: ${p.name}${price}${img}\nDescription: ${descSnippet}`;
    })
    .join('\n\n');
  const text = (header + body).slice(0, maxChars);
  return text;
}


