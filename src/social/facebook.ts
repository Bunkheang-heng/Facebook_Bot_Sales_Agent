import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import crypto from 'crypto';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const graph = axios.create({
  baseURL: 'https://graph.facebook.com/v18.0',
  timeout: 10000,
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

export async function sendSenderAction(pageAccessToken: string, recipientPsid: string, action: 'typing_on' | 'typing_off' | 'mark_seen'): Promise<void> {
  await graph.post('/me/messages', { recipient: { id: recipientPsid }, sender_action: action }, { params: buildParams(pageAccessToken) });
}

export async function sendTextMessage(pageAccessToken: string, recipientPsid: string, text: string): Promise<void> {
  await graph.post('/me/messages', {
    recipient: { id: recipientPsid },
    messaging_type: 'RESPONSE',
    message: { text }
  }, { params: buildParams(pageAccessToken) });
}


