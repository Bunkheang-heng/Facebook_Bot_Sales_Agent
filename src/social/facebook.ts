import axios from 'axios';
import crypto from 'crypto';

export async function sendTextMessage(
  pageAccessToken: string,
  recipientPsid: string,
  text: string
): Promise<void> {
  const url = `https://graph.facebook.com/v18.0/me/messages`;
  // Compute appsecret_proof for added security when calling Graph API
  const appSecret = process.env.APP_SECRET;
  const appsecret_proof = appSecret
    ? crypto.createHmac('sha256', appSecret).update(pageAccessToken).digest('hex')
    : undefined;
  const payload = {
    recipient: { id: recipientPsid },
    messaging_type: 'RESPONSE',
    message: { text }
  };
  const params = {
    access_token: pageAccessToken,
    ...(appsecret_proof ? { appsecret_proof } : {})
  } as const;

  let attempt = 0;
  const maxAttempts = 3;
  // Exponential backoff for transient errors
  // 250ms, 500ms, 1000ms
  const backoffs = [250, 500, 1000];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await axios.post(url, payload, { params, timeout: 10000 });
      return;
    } catch (err: any) {
      const status = err?.response?.status;
      const isTransient = status >= 500 || status === 429;
      attempt += 1;
      if (!isTransient || attempt >= maxAttempts) {
        throw err;
      }
      const delay = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}


