import { z } from 'zod';

const Env = z.object({
  OPENAI_API_KEY: z.string().min(1),
  PAGE_ACCESS_TOKEN: z.string().min(1),
  VERIFY_TOKEN: z.string().min(1),
  APP_SECRET: z.string().min(1),
  // Supabase (server-side)
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  SUPABASE_MATCH_TEXT_FN: z.string().default('search_products_hybrid_text'),
  SUPABASE_MATCH_EMBEDDING_FN: z.string().default('search_products_by_embedding'),
  // Google Cloud Vertex AI
  GOOGLE_CLOUD_LOCATION: z.string().min(1),
  GOOGLE_CLOUD_PROJECT_ID: z.string().min(1),
  GOOGLE_CLOUD_CLIENT_EMAIL: z.string().email(),
  GOOGLE_CLOUD_PRIVATE_KEY: z.string().min(40),
  // RAG tuning
  RAG_MATCH_COUNT: z.coerce.number().default(5),
  RAG_MIN_SIMILARITY: z.coerce.number().default(0),
  // Product filtering by tenant
  PRODUCT_TENANT_ID: z.string().optional(),
  PORT: z.coerce.number().default(3000)
});

export const env = Env.parse(process.env);


