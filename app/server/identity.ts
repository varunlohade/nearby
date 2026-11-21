// Visitor identity for communities, presence and agent keys.
//
// Same scheme as the Nexconn guest session (server/nexconn.ts): a random guest id
// in an HttpOnly cookie, signed with HMAC on the server, so nobody can claim
// another visitor's id. This cookie covers every /api route (the Nexconn one is
// scoped to /api/nexconn). Display names are chosen by the visitor and stored
// per id; they are labels, not proof of identity.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getStore } from './store.js';

const COOKIE = 'nearby_me';
let secret = '';

/** Set once at startup from the server's secrets. */
export function configureIdentity(value: string) {
  secret = value || 'nearby-local-development-only';
}

const sign = (id: string) => createHmac('sha256', secret || 'nearby-local-development-only').update('nearby-me:' + id).digest('hex');

export interface Visitor { id: string; name: string }

/** The caller's signed id; issues a new one (and sets the cookie) when missing. */
export async function visitor(req: IncomingMessage, res: ServerResponse): Promise<Visitor> {
  const raw = req.headers.cookie?.split(/;\s*/).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const match = /^(v[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(raw ?? '');
  let id: string;
  if (match && timingSafeEqual(Buffer.from(sign(match[1])), Buffer.from(match[2]))) id = match[1];
  else {
    id = 'v' + randomBytes(16).toString('hex');
    const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https') || !!process.env.VERCEL;
    res.setHeader('Set-Cookie', `${COOKIE}=${id}.${sign(id)}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=31536000${secure ? '; Secure' : ''}`);
  }
  const profile = await getStore().hget<{ name: string }>('people', id).catch(() => null);
  return { id, name: profile?.name || 'Neighbour ' + id.slice(-4).toUpperCase() };
}

export async function rename(id: string, name: string) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (clean.length < 2) throw new Error('Pick a name of at least 2 characters.');
  await getStore().hset('people', id, { name: clean });
  return clean;
}
