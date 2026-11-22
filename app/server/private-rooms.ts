import type { IncomingMessage, ServerResponse } from 'node:http';
import { visitor } from './identity.js';
import { allow, getStore } from './store.js';

interface RequestKey {
  name: string;
  publicKey: string;
}
const base64 = (s: unknown, length: number): s is string =>
  typeof s === 'string' && s.length === length && /^[A-Za-z0-9+/]+=*$/.test(s);
export async function createPrivate(id: string, wrapped: unknown, req: IncomingMessage, res: ServerResponse) {
  if (!base64(wrapped, 344)) throw new Error('Invalid encrypted room key');
  const who = await visitor(req, res);
  const store = getStore();
  await store.set('private:owner:' + id, who.id, 7 * 86400);
  await store.hset('private:keys:' + id, who.id, wrapped);
}

export async function privateRoom(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
) {
  const send = (code: number, value: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const store = getStore(),
    who = await visitor(req, res);
  const owner = await store.get<string>('private:owner:' + id);
  if (!owner) return send(404, { error: 'Room has expired.' });
  const keys = 'private:keys:' + id,
    requests = 'private:requests:' + id,
    messages = 'private:messages:' + id;
  const key = await store.hget<string>(keys, who.id);
  if (req.method === 'GET') {
    if (!key) return send(200, { state: (await store.hget(requests, who.id)) ? 'pending' : 'guest' });
    return send(200, {
      state: owner === who.id ? 'owner' : 'member',
      key,
      requests: owner === who.id ? await store.hgetall<RequestKey>(requests) : undefined,
      messages: await store.tail(messages, 60),
    });
  }
  if (req.method !== 'POST') return send(405, { error: 'Unsupported method' });
  if (!(await allow('private:' + who.id, 100, 60))) return send(429, { error: 'Please wait a moment.' });
  if (body.action === 'request' && !key) {
    if (!base64(body.publicKey, 392)) return send(400, { error: 'Invalid device key.' });
    await store.hset(requests, who.id, {
      publicKey: body.publicKey,
      name: String(body.name || who.name)
        .trim()
        .slice(0, 40),
    });
  } else if (body.action === 'approve' || body.action === 'decline') {
    if (who.id !== owner) return send(403, { error: 'Owner approval required.' });
    if (typeof body.id !== 'string' || !/^v[a-f0-9]{32}$/.test(body.id))
      return send(400, { error: 'Unknown request.' });
    const request = await store.hget<RequestKey>(requests, body.id);
    if (!request) return send(409, { error: 'Request already handled.' });
    if (body.action === 'approve') {
      if (!base64(body.key, 344) || request.publicKey !== body.publicKey)
        return send(409, { error: 'Device key changed. Refresh and try again.' });
      await store.hset(keys, body.id, body.key);
    }
    await store.hdel(requests, body.id);
  } else if (body.action === 'send' && key) {
    if (
      !base64(body.iv, 16) ||
      typeof body.cipher !== 'string' ||
      !/^[A-Za-z0-9+/]{20,3200}={0,2}$/.test(body.cipher)
    )
      return send(400, { error: 'Invalid encrypted message.' });
    await store.pushCapped(messages, { iv: body.iv, cipher: body.cipher }, 60);
  } else return send(403, { error: 'Approval required.' });
  return send(200, { ok: true });
}
