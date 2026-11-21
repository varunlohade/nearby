// Things people create on the map: chat rooms, events and audio sessions.
//
// Discovery scheme: every item is stored once, by its exact point, in a shared
// registry (Redis hash "places"; see store.ts). Clients ask for
// the items inside the map viewport (GET /api/places?bbox=…), so anyone who looks
// at that part of the world sees the pins, whichever "area" they landed in.
// Each item's conversation is its own Nexconn open channel: nearby_c_<id>.
//
// Audio sessions are peer-to-peer WebRTC (a mesh of up to 6 people). This server
// only relays the connection handshake: each peer has a short-lived inbox in the
// store, and its Server-Sent Events stream polls that inbox. Audio never passes
// through the server. Streams end before the function time limit and the browser
// reconnects with the same peer id.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allow, clientIp, getStore } from './store.js';

type Next = (error?: unknown) => void;
type Kind = 'room' | 'event' | 'audio';
const CATEGORIES = ['talk', 'sport', 'culture', 'social', 'wellness', 'help'];

export interface Created {
  id: string; kind: Kind; title: string; lat: number; lng: number; place: string;
  start?: number; category?: string; by: string; created: number; expires: number; live?: number;
}

const MAX_AUDIO = 6;
const PEER_TIMEOUT = 25000;   // a peer that has not polled for this long has left
const POLL_MS = 800;
const STREAM_MS = 270000;     // end the stream before Vercel's 300 s limit; the client reconnects

async function load(): Promise<Created[]> {
  const store = getStore();
  const all = await store.hgetall<Created>('places');
  const now = Date.now();
  const expired = Object.values(all).filter(c => c.expires < now - 3600000).map(c => c.id);
  if (expired.length) void store.hdel('places', ...expired);
  return Object.values(all).filter(c => !expired.includes(c.id)).sort((a, b) => a.created - b.created);
}

// ---------------------------------------------------------------- audio relay
interface PeerInfo { name: string; seen: number }
const peersKey = (id: string) => `aud:${id}:peers`;
const inboxKey = (id: string, peer: string) => `aud:${id}:in:${peer}`;
async function peersOf(id: string) {
  const all = await getStore().hgetall<PeerInfo>(peersKey(id));
  const now = Date.now();
  const gone = Object.keys(all).filter(p => now - all[p].seen > PEER_TIMEOUT);
  if (gone.length) void getStore().hdel(peersKey(id), ...gone);
  gone.forEach(p => delete all[p]);
  return all;
}
async function live(id: string) { return Object.keys(await peersOf(id)).length; }
function push(res: ServerResponse, event: string, data: unknown) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

// ---------------------------------------------------------------- helpers
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const allowed = (req: IncomingMessage) => allow('create:' + clientIp(req.headers, req.socket?.remoteAddress), 30, 3600);
async function readJson(req: IncomingMessage, limit = 4000): Promise<any> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw new Error('Request too large'); }
  return JSON.parse(raw || '{}');
}
async function placeName(lat: number, lng: number) {
  try {
    const response = await fetch(`https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&limit=1&lang=en`,
      { headers: { 'User-Agent': 'nearby-create/0.1' }, signal: AbortSignal.timeout(5000) });
    const p = (await response.json())?.features?.[0]?.properties ?? {};
    const near = p.name || p.street || p.district || p.locality;
    const town = p.city || p.county || p.state;
    return [near, town !== near && town, p.country].filter(Boolean).slice(0, 3).join(', ') || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  } catch { return `${lat.toFixed(3)}, ${lng.toFixed(3)}`; }
}

export function placesApi() {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/api/places') && !url.pathname.startsWith('/api/audio/')) return next();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      // Where is this point? Used by the create menu.
      if (url.pathname === '/api/places/where' && req.method === 'GET') {
        const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(400, { error: 'lat and lng required' });
        return send(200, { place: await placeName(lat, lng) });
      }

      // Items inside a viewport.
      if (url.pathname === '/api/places' && req.method === 'GET') {
        const [w, s, e, n] = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
        if (![w, s, e, n].every(Number.isFinite)) return send(400, { error: 'bbox=w,s,e,n required' });
        const now = Date.now();
        const inBox = (c: Created) => c.lat >= s && c.lat <= n && (w <= e ? c.lng >= w && c.lng <= e : c.lng >= w || c.lng <= e);
        const inView = (await load()).filter(inBox).slice(-300);
        const counts = new Map(await Promise.all(inView.filter(c => c.kind === 'audio').map(async c => [c.id, await live(c.id)] as const)));
        const list = inView.filter(c => c.expires > now || (counts.get(c.id) ?? 0) > 0).map(c => ({ ...c, live: c.kind === 'audio' ? counts.get(c.id) ?? 0 : undefined }));
        return send(200, { items: list });
      }

      // Create.
      if (url.pathname === '/api/places' && req.method === 'POST') {
        if (!(await allowed(req))) return send(429, { error: 'Too many new places this hour. Try again later.' });
        const body = await readJson(req);
        const kind = body.kind as Kind;
        const title = clean(body.title, 60), by = clean(body.by, 40) || 'Neighbour';
        const lat = Number(body.lat), lng = Number(body.lng);
        if (!['room', 'event', 'audio'].includes(kind)) return send(400, { error: 'Choose a chat room, event or audio session.' });
        if (title.length < 2) return send(400, { error: 'Give it a name.' });
        if (!Number.isFinite(lat) || Math.abs(lat) > 85 || !Number.isFinite(lng) || Math.abs(lng) > 180) return send(400, { error: 'Pick a spot on the map.' });
        const now = Date.now();
        let start: number | undefined;
        if (kind === 'event') {
          start = Number(body.start);
          if (!Number.isFinite(start) || start < now - 15 * 60000 || start > now + 366 * 86400000) return send(400, { error: 'Pick a start time in the next year.' });
        }
        const item: Created = {
          id: 'c' + randomBytes(6).toString('hex'), kind, title, lat, lng,
          place: clean(body.place, 80) || await placeName(lat, lng),
          start, category: kind === 'event' && CATEGORIES.includes(body.category) ? body.category : undefined,
          by, created: now,
          expires: kind === 'event' ? start! + 6 * 3600000 : kind === 'audio' ? now + 24 * 3600000 : now + 7 * 86400000,
        };
        await getStore().hset('places', item.id, item);
        return send(201, { item });
      }

      // Audio: join (Server-Sent Events stream of the handshake).
      const audio = url.pathname.match(/^\/api\/audio\/(c[a-f0-9]{12})\/(stream|signal|leave)$/);
      if (audio) {
        const [, id, action] = audio;
        const item = (await load()).find(c => c.id === id && c.kind === 'audio');
        if (!item) return send(404, { error: 'This audio session has ended.' });
        if (action === 'stream' && req.method === 'GET') {
          const peer = clean(url.searchParams.get('peer'), 40), name = clean(url.searchParams.get('name'), 40) || 'Neighbour';
          if (!/^[a-z0-9-]{8,40}$/i.test(peer)) return send(400, { error: 'Bad peer id' });
          const store = getStore();
          let known = await peersOf(id);
          if (Object.keys(known).length >= MAX_AUDIO && !known[peer]) return send(409, { error: `This session is full (${MAX_AUDIO} people).` });
          const rejoining = !!known[peer];
          await store.hset(peersKey(id), peer, { name, seen: Date.now() });
          if (item.expires < Date.now() + 3600000) await store.hset('places', id, { ...item, expires: Date.now() + 3600000 });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          delete known[peer];
          push(res, 'welcome', { rejoin: rejoining, peers: Object.entries(known).map(([p, info]) => ({ peer: p, name: info.name })) });
          let open = true;
          req.on('close', () => { open = false; });
          const started = Date.now();
          let lastPing = started;
          // Poll the shared inbox and peer list; turn changes into events.
          while (open && Date.now() - started < STREAM_MS) {
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
            if (!open) break;
            await store.hset(peersKey(id), peer, { name, seen: Date.now() });
            const [now, inbox] = await Promise.all([peersOf(id), store.drain<{ from: string; data: unknown }>(inboxKey(id, peer))]);
            delete now[peer];
            for (const p of Object.keys(now)) if (!known[p]) push(res, 'join', { peer: p, name: now[p].name });
            for (const p of Object.keys(known)) if (!now[p]) push(res, 'leave', { peer: p });
            known = now;
            for (const message of inbox) push(res, 'signal', message);
            if (Date.now() - lastPing > 15000) { res.write(': ping\n\n'); lastPing = Date.now(); }
          }
          if (open) {
            // Time limit reached: ask the browser to reconnect with the same peer id.
            push(res, 'reconnect', {});
            res.end();
          } else {
            await store.hdel(peersKey(id), peer);
            await store.del(inboxKey(id, peer));
          }
          return;
        }
        if (action === 'signal' && req.method === 'POST') {
          const body = await readJson(req, 20000);
          const from = String(body.from), to = String(body.to);
          const peers = await peersOf(id);
          if (!peers[to] || !peers[from]) return send(404, { error: 'Peer left' });
          await getStore().rpush(inboxKey(id, to), { from, data: body.data }, 120);
          return send(200, { ok: true });
        }
        if (action === 'leave' && req.method === 'POST') {
          const body = await readJson(req, 2000);
          await getStore().hdel(peersKey(id), String(body.peer));
          return send(200, { ok: true });
        }
      }
      return send(404, { error: 'Unknown route' });
    } catch (error) {
      return send(400, { error: (error as Error).message || 'Bad request' });
    }
  };
}
