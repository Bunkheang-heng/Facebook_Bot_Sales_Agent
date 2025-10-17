import { z } from 'zod';

const Env = z.object({
  OPENAI_API_KEY: z.string().min(1),
  PAGE_ACCESS_TOKEN: z.string().min(1),
  VERIFY_TOKEN: z.string().min(1),
  APP_SECRET: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(40),
  PORT: z.coerce.number().default(3000)
});

export const env = Env.parse(process.env);


