import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import crypto from 'crypto';
import type { RetrievedProduct } from '../services/rag';
import { logger } from '../core/logger';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const graph = axios.create({
  baseURL: 'https://graph.facebook.com/v18.0',
  timeout: 30000, // Increased to 30s for slower networks
  httpAgent,
  httpsAgent
});

function buildParams(pageAccessToken: string) {
  const appSecret = process.env.APP_SECRET;
  const appsecret_proof = appSecret
    ? crypto.createHmac('sha256', appSecret).update(pageAccessToken).digest('hex')
    : undefined;
  return { access_token: pageAccessToken, ...(appsecret_proof ? { appsecret_proof } : {}) } as const;
}

/**
 * Retry helper for transient network errors
 */
async function retryOnTimeout<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      const is5xx = err.response?.status >= 500 && err.response?.status < 600;
      const shouldRetry = (isTimeout || is5xx) && attempt < retries;
      
      if (shouldRetry) {
        logger.warn({ attempt: attempt + 1, err: err.message }, 'Retrying Graph API call');
        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Retry exhausted');
}

export async function sendSenderAction(pageAccessToken: string, recipientPsid: string, action: 'typing_on' | 'typing_off' | 'mark_seen'): Promise<void> {
  await retryOnTimeout(() => 
    graph.post('/me/messages', { recipient: { id: recipientPsid }, sender_action: action }, { params: buildParams(pageAccessToken) })
  );
}

export async function sendTextMessage(pageAccessToken: string, recipientPsid: string, text: string): Promise<void> {
  await retryOnTimeout(() => 
    graph.post('/me/messages', {
      recipient: { id: recipientPsid },
      messaging_type: 'RESPONSE',
      message: { text }
    }, { params: buildParams(pageAccessToken) })
  );
}

export async function sendProductCarousel(pageAccessToken: string, recipientPsid: string, products: RetrievedProduct[]): Promise<void> {
  if (!products || products.length === 0) return;

  const info = {
    recipientPsid,
    productCount: products.length,
    products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, image_url: p.image_url }))
  }

  console.log(info); 
  
  logger.info(
    'Messenger: Sending product carousel'
  );

  const elements = products.slice(0, 10).map((p) => {
    const element: any = {
      title: p.name?.slice(0, 80) || 'Product',
      buttons: (
        p.price == null
          ? []
          : [{ type: 'postback', title: `$${p.price}`, payload: `PRICE_${p.id}` }]
      )
    };

    // Add subtitle if exists
    if (p.description) {
      element.subtitle = p.description.toString().slice(0, 80);
    }

    // Add image_url only if it's a valid URL
    if (p.image_url && typeof p.image_url === 'string' && p.image_url.trim().length > 0) {
      const url = p.image_url.trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        element.image_url = url;
      }
    }

    return element;
  });

  const payload = {
    recipient: { id: recipientPsid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements
        }
      }
    }
  };

  console.log('payload', payload);

  await retryOnTimeout(() => 
    graph.post('/me/messages', payload, { params: buildParams(pageAccessToken) })
  );
  logger.info({ recipientPsid, cardCount: elements.length }, 'Messenger: Carousel sent');
}


