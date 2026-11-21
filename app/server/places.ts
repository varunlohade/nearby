// Things people create on the map: chat rooms, events and audio sessions.
//
// Discovery scheme: every item is stored once, by its exact point, in a small
// registry on this server (persisted to app/.data/places.json). Clients ask for
// the items inside the map viewport (GET /api/places?bbox=…), so anyone who looks
// at that part of the world sees the pins, whichever "area" they landed in.
// Each item's conversation is its own Nexconn open channel: nearby_c_<id>.
//
// Audio sessions are peer-to-peer WebRTC (a mesh of up to 6 people). This server
// only relays the connection handshake over Server-Sent Events; audio never passes
// through it.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Next = (error?: unknown) => void;
type Kind = 'room' | 'event' | 'audio';
const CATEGORIES = ['talk', 'sport', 'culture', 'social', 'wellness', 'help'];

export interface Created {
  id: string; kind: Kind; title: string; lat: number; lng: number; place: string;
  start?: number; category?: string; by: string; created: number; expires: number; live?: number;
}

const FILE = path.join(process.cwd(), '.data', 'places.json');
const MAX_AUDIO = 6;
let items: Created[] | undefined;
let saving: Promise<void> = Promise.resolve();

async function load() {
  if (items) return items;
  try { items = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { items = []; }
  return items!;
}
function save() {
  saving = saving.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(items ?? [], null, 1));
  }).catch(error => console.error('[places] save failed', error));
}

// ---------------------------------------------------------------- audio relay
interface Peer { id: string; name: string; res: ServerResponse }
const sessions = new Map<string, Map<string, Peer>>();
const live = (id: string) => sessions.get(id)?.size ?? 0;
function push(res: ServerResponse, event: string, data: unknown) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

// ---------------------------------------------------------------- helpers
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const recent = new Map<string, number[]>();
function allowed(req: IncomingMessage) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'local').split(',')[0];
  const now = Date.now();
  const list = (recent.get(ip) ?? []).filter(t => now - t < 3600000);
  if (list.length >= 30) return false;
  list.push(now); recent.set(ip, list);
  return true;
}
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
        const list = (await load()).filter(c => (c.expires > now || live(c.id) > 0) && inBox(c)).slice(-300)
          .map(c => ({ ...c, live: c.kind === 'audio' ? live(c.id) : undefined }));
        return send(200, { items: list });
      }

      // Create.
      if (url.pathname === '/api/places' && req.method === 'POST') {
        if (!allowed(req)) return send(429, { error: 'Too many new places this hour. Try again later.' });
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
        (await load()).push(item);
        save();
        return send(201, { item });
      }

      // Audio: join (Server-Sent Events stream of the handshake).
      const audio = url.pathname.match(/^\/api\/audio\/(c[a-f0-9]{12})\/(stream|signal)$/);
      if (audio) {
        const [, id, action] = audio;
        const item = (await load()).find(c => c.id === id && c.kind === 'audio');
        if (!item) return send(404, { error: 'This audio session has ended.' });
        if (action === 'stream' && req.method === 'GET') {
          const peer = clean(url.searchParams.get('peer'), 40), name = clean(url.searchParams.get('name'), 40) || 'Neighbour';
          if (!/^[a-z0-9-]{8,40}$/i.test(peer)) return send(400, { error: 'Bad peer id' });
          const room = sessions.get(id) ?? new Map<string, Peer>();
          if (room.size >= MAX_AUDIO && !room.has(peer)) return send(409, { error: `This session is full (${MAX_AUDIO} people).` });
          sessions.set(id, room);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          push(res, 'welcome', { peers: [...room.values()].filter(p => p.id !== peer).map(p => ({ peer: p.id, name: p.name })) });
          for (const other of room.values()) if (other.id !== peer) push(other.res, 'join', { peer, name });
          room.set(peer, { id: peer, name, res });
          item.expires = Math.max(item.expires, Date.now() + 3600000);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => {
            clearInterval(ping);
            if (room.get(peer)?.res !== res) return;
            room.delete(peer);
            for (const other of room.values()) push(other.res, 'leave', { peer });
            if (!room.size) sessions.delete(id);
          });
          return;
        }
        if (action === 'signal' && req.method === 'POST') {
          const body = await readJson(req, 20000);
          const target = sessions.get(id)?.get(String(body.to));
          if (!target || !sessions.get(id)?.has(String(body.from))) return send(404, { error: 'Peer left' });
          push(target.res, 'signal', { from: body.from, data: body.data });
          return send(200, { ok: true });
        }
      }
      return send(404, { error: 'Unknown route' });
    } catch (error) {
      return send(400, { error: (error as Error).message || 'Bad request' });
    }
  };
}
