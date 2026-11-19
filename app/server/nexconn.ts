// Server-only Nexconn Platform Chat API calls. The App Secret never leaves this file.
// Docs: https://docs.nexconn.ai/platform-chat-api/prepare-to-use-api/auth.md
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Creds { appKey: string; secret: string; host: string }

async function call(c: Creds, path: string, body: unknown): Promise<{ code: number; result?: any }> {
  const nonce = randomBytes(6).toString('hex');
  const timestamp = String(Date.now());
  const signature = createHash('sha1').update(c.secret + nonce + timestamp).digest('hex');
  const res = await fetch(`https://${c.host}${path}`, {
    method: 'POST',
    headers: {
      'App-Key': c.appKey, Nonce: nonce, Timestamp: timestamp, Signature: signature,
      'X-Request-ID': randomUUID(), 'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ code: number; result?: any }>;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function nexconnApi(c: Creds) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/nexconn/') || req.method !== 'POST') return next();
    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (!c.appKey || !c.secret) return send(503, { error: 'NEXCONN_APP_KEY or NEXCONN_APP_SECRET missing' });
    try {
      const body = await readJson(req);
      if (req.url === '/api/nexconn/token') {
        const userId = String(body.userId ?? ''), name = String(body.name ?? '').slice(0, 64);
        if (!ID.test(userId) || !name) return send(400, { error: 'bad userId or name' });
        const r = await call(c, '/v4/auth/access-token/issue', { userId, name });
        if (r.code !== 0) return send(502, { error: `token issue failed, code ${r.code}` });
        return send(200, { token: r.result.accessToken });
      }
      if (req.url === '/api/nexconn/room') {
        const channelId = String(body.channelId ?? '');
        if (!ID.test(channelId)) return send(400, { error: 'bad channelId' });
        // Destroy after 7 days without activity. A repeat create for an existing room is harmless.
        const r = await call(c, '/v4/open-channel/create', { channelId, destroyType: 0, ttlMinutes: 10080 });
        return send(200, { code: r.code });
      }
      return send(404, { error: 'unknown route' });
    } catch (e) {
      console.error('[nexconn-api]', (e as Error).message);
      return send(500, { error: 'nexconn api call failed' });
    }
  };
}
