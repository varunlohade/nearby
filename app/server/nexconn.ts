// Nexconn Platform API requests are signed on the server.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';


interface Creds { appKey: string; secret: string; host: string }

async function call(c: Creds, path: string, body: unknown): Promise<{code: number; result?: {accessToken?: string; channelId?: string}}> {
  const nonce = randomBytes(6).toString('hex');
  const timestamp = String(Date.now());
  const signature = createHash('sha1').update(c.secret + nonce + timestamp).digest('hex');
  const res = await fetch('https://' + c.host + path, {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: {'App-Key':c.appKey, Nonce:nonce, Timestamp:timestamp, Signature:signature, 'X-Request-ID':randomUUID(), 'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  // The Platform API also returns structured codes on HTTP 4xx (e.g. a missing room).
  const data = await res.json();
  if (typeof data?.code !== 'number' || (!res.ok && data.code === 0)) throw new Error('Platform HTTP ' + res.status);
  return data;
}

function guest(req: IncomingMessage, secret: string) {
  const value = req.headers.cookie?.split(/;\s*/).find(item => item.startsWith('nearby_session='))?.slice('nearby_session='.length);
  const match = /^(g[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value || '');
  const sign = (id: string) => createHmac('sha256', secret).update('nearby-guest:' + id).digest('hex');
  if (match && timingSafeEqual(Buffer.from(sign(match[1])), Buffer.from(match[2]))) return {id:match[1]};
  const id = 'g' + randomBytes(16).toString('hex');
  return {id, cookie:'nearby_session=' + id + '.' + sign(id) + '; HttpOnly; SameSite=Strict; Path=/api/nexconn; Max-Age=31536000'};
}

export function nexconnApi(c: Creds) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/nexconn/')) return next();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/nexconn/config' && req.method === 'GET') {
      if (Boolean(c.secret) !== Boolean(c.appKey)) return send(503, {error:'Incomplete Nexconn credentials'});
      const region = c.host.includes('.us-') ? 'NA' : c.host.includes('.sau-') ? 'SA' : 'SG';
      return send(200, {appKey:c.secret ? c.appKey : '', region});
    }
    if (req.url === '/api/nexconn/roam') return send(410, {error:'Free Roam is paused.'});
    if (req.method !== 'POST') return send(405, {error:'POST required'});
    if (!c.appKey || !c.secret) return send(503, {error:'Nexconn credentials missing'});
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, {error:'JSON required'});
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) return send(413, {error:'Request too large'});
      }
      let body;
      try { body = JSON.parse(raw); } catch { return send(400, {error:'Invalid JSON'}); }
      if (!body || typeof body !== 'object') return send(400, {error:'Invalid request'});
      const session = guest(req, c.secret);
      if (req.url === '/api/nexconn/token') {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
        if (!name) return send(400, {error:'Name required'});
        const r = await call(c, '/v4/auth/access-token/issue', {userId:session.id, name});
        if (r.code !== 0 || !r.result?.accessToken) return send(502, {error:'Token issue failed (' + r.code + ')'});
        if (session.cookie) res.setHeader('Set-Cookie', session.cookie + (req.headers.origin?.startsWith('https://') ? '; Secure' : ''));
        return send(200, {token:r.result.accessToken});
      }
      if (req.url === '/api/nexconn/room') {
        if (session.cookie) return send(401, {error:'Connect first'});
        const roomId = body.channelId;
        if (typeof roomId !== 'string' || !roomId.startsWith('nearby_') || roomId.length <= 7)
          return send(400, {error:'Choose a conversation on the map.'});
        // Keep existing channel histories. External event IDs can be mixed-case or long.
        const channelId = /^nearby_[a-z0-9_-]{1,57}$/.test(roomId)
          ? roomId : 'nearby_ext_' + createHash('sha256').update(roomId).digest('hex').slice(0, 48);
        const path = '/v4/open-channel/';
        const existing = await call(c, path+'get', {channelId});
        if (existing.code === 0) return send(200, {channelId});
        if (existing.code !== 23410) return send(502, {error:'Room lookup failed (' + existing.code + ')'});
        const created = await call(c, path+'create', {channelId, destroyType:0, ttlMinutes:10080});
        // Another visitor may have created the same room between lookup and create.
        if (created.code !== 0 && (await call(c, path+'get', {channelId})).code !== 0)
          return send(502, {error:'Room creation failed (' + created.code + ')'});
        return send(200, {channelId});
      }
      return send(404, {error:'Unknown route'});
    } catch { return send(502, {error:'Nexconn Platform API unavailable'}); }
  };
}
