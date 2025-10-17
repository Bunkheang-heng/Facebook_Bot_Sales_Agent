# Messenger Bot (TypeScript/Node.js)

Minimal Facebook Messenger webhook with signature verification and echo reply.

## Prerequisites
- Node.js 18+
- A Facebook Page and a Meta App with Messenger product

## Setup
1. Copy env template and fill values:
   ```bash
   cp .env.example .env
   # Fill PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APP_SECRET
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run locally:
   ```bash
   npm run dev
   ```
4. Expose webhook (choose one):
   - Using ngrok:
     ```bash
     ngrok http 3000
     ```
     This will give you a public URL to use as your webhook endpoint.
   - Or deploy to Vercel/Cloud Run/Lambda
5. Configure webhook in Meta App (Messenger > Settings):
   - Callback URL: `https://<your-ngrok-subdomain>/webhook`
   - Verify Token: the same as `VERIFY_TOKEN`
   - Subscribe to events: messages, messaging_postbacks

## Scripts
- `npm run dev` - ts-node + nodemon
- `npm run build` - compile to `dist`
- `npm start` - run compiled server

## Files
- `src/server.ts` - Express server, verification, event handling
- `src/social/facebook.ts` - Graph API client for sending messages

## Deploy to Vercel
1. Create or select a Vercel project and link this repo.
2. In Vercel Project Settings → Environment Variables, add:
   - `OPENAI_API_KEY`
   - `PAGE_ACCESS_TOKEN`
   - `VERIFY_TOKEN`
   - `APP_SECRET`
3. Deploy. The following endpoints will be available:
   - Health: `https://<your-vercel-domain>/`
   - Webhook (Meta): `https://<your-vercel-domain>/webhook`
4. In your Meta App (Messenger → Settings), configure:
   - Callback URL: `https://<your-vercel-domain>/webhook`
   - Verify Token: the same as `VERIFY_TOKEN`
   - Subscribe to events: messages, messaging_postbacks
5. Notes
   - The Vercel runtime is set to Node 20 via `vercel.json`.
   - Local `.env` is not used on Vercel; set env vars in the dashboard.

