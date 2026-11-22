// Communities, requests and neighbours-nearby presence.
//
// A community is a persistent group pinned to a place anywhere in the world. It
// has members, a live chat (its Nexconn open channel "nearby_<id>"), a board of
// posts, and a requests board ("need a plumber tomorrow"). Requests collect
// replies; a reply may carry a contact the replier chose to share, which only
// the requester (and their agent) can ever read.
//
// Redis layout (see store.ts):
//   communities              hash  id -> Community
//   cmembers:<cid>           hash  visitorId -> { name, joined }
//   mycomms:<visitorId>      hash  cid -> joined
//   cposts:<cid>             list  Post (newest 200)
//   creqs:<cid>              hash  rid -> Request
//   reqindex                 hash  rid -> cid
//   creplies:<rid>           list  Reply (newest 100)
//   myreqs:<visitorId>       list  { community, request } (newest 100)
//   presence                 hash  visitorId -> { name, lat, lng, seen }   (opt-in, ~500 m)

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { allow, clientIp, getStore } from './store.js';
import { rename, visitor } from './identity.js';

type Next = (error?: unknown) => void;

export interface Author { id: string; name: string; agent?: { label: string; kind: string } }
export interface Community {
  id: string; name: string; description: string; tags: string[]; emoji: string; color: string;
  lat: number; lng: number; place: string; by: Author; created: number; members?: number;
}
export interface Post { id: string; community: string; text: string; by: Author; created: number }
export interface Request {
  id: string; community: string; title: string; details: string; wantsContact: boolean;
  by: Author; created: number; status: 'open' | 'done'; replies: number;
}
export interface Reply { id: string; request: string; message: string; contact?: string; by: Author; created: number }

const COLORS = ['#f5bd52', '#75c4ee', '#f495ae', '#b5a1f0', '#9dc48c', '#e2ae85'];
const PRESENCE_TTL = 3 * 60000;
const id = (prefix: string) => prefix + randomBytes(6).toString('hex');
export const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const cleanLong = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';
const rad = (d: number) => d * Math.PI / 180;
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const validPoint = (lat: number, lng: number) => Number.isFinite(lat) && Math.abs(lat) <= 85 && Number.isFinite(lng) && Math.abs(lng) <= 180;

async function placeName(lat: number, lng: number) {
  try {
    const response = await fetch(`https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&limit=1&lang=en`,
      { headers: { 'User-Agent': 'nearby-communities/0.1' }, signal: AbortSignal.timeout(5000) });
    const p = (await response.json())?.features?.[0]?.properties ?? {};
    const near = p.district || p.locality || p.name || p.street;
    const town = p.city || p.county || p.state;
    return [near, town !== near && town, p.country].filter(Boolean).slice(0, 3).join(', ') || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  } catch { return `${lat.toFixed(3)}, ${lng.toFixed(3)}`; }
}

// ---------------------------------------------------------------- data (shared by people and agents)
export async function allCommunities(): Promise<Community[]> {
  return Object.values(await getStore().hgetall<Community>('communities'));
}

export async function findCommunities(opts: { lat?: number; lng?: number; radiusKm?: number; bbox?: number[]; query?: string; limit?: number }) {
  const q = (opts.query ?? '').toLowerCase().trim();
  let list = await allCommunities();
  if (opts.bbox) {
    const [w, s, e, n] = opts.bbox;
    list = list.filter(c => c.lat >= s && c.lat <= n && (w <= e ? c.lng >= w && c.lng <= e : c.lng >= w || c.lng <= e));
  }
  const center = opts.lat !== undefined && opts.lng !== undefined ? { lat: opts.lat, lng: opts.lng } : undefined;
  if (center) list = list.filter(c => km(center, c) <= (opts.radiusKm ?? 25));
  if (q) list = list.filter(c => [c.name, c.description, c.place, ...c.tags].join(' ').toLowerCase().includes(q));
  const counted = await Promise.all(list.map(async c => ({ ...c, members: await getStore().hlen('cmembers:' + c.id) })));
  return counted.sort((a, b) => center ? km(center, a) - km(center, b) : b.created - a.created).slice(0, opts.limit ?? 200);
}

export async function getCommunity(cid: string) {
  const c = await getStore().hget<Community>('communities', cid);
  if (!c) return null;
  return { ...c, members: await getStore().hlen('cmembers:' + cid) };
}

export async function createCommunity(by: Author, input: Record<string, unknown>) {
  const name = clean(input.name, 50), description = cleanLong(input.description, 280);
  const lat = Number(input.lat), lng = Number(input.lng);
  if (name.length < 3) throw new Error('Give the community a name (3 characters or more).');
  if (!validPoint(lat, lng)) throw new Error('Pick a spot on the map.');
  const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(','))
    .map(t => clean(t, 20).toLowerCase().replace(/^#/, '')).filter(Boolean).slice(0, 5);
  const emoji = clean(input.emoji, 4) || '🏘️';
  const color = COLORS.includes(String(input.color)) ? String(input.color) : COLORS[Math.floor(Math.random() * COLORS.length)];
  const community: Community = {
    id: id('k'), name, description, tags, emoji, color, lat, lng,
    place: clean(input.place, 80) || await placeName(lat, lng), by: { id: by.id, name: by.name, agent: by.agent }, created: Date.now(),
  };
  await getStore().hset('communities', community.id, community);
  await join(community.id, by);
  return { ...community, members: 1 };
}

export async function join(cid: string, who: Author) {
  if (!(await getStore().hget('communities', cid))) throw new Error('Community not found.');
  await getStore().hset('cmembers:' + cid, who.id, { name: who.name, joined: Date.now() });
  await getStore().hset('mycomms:' + who.id, cid, Date.now());
}
export async function leave(cid: string, who: string) {
  await getStore().hdel('cmembers:' + cid, who);
  await getStore().hdel('mycomms:' + who, cid);
}
export async function members(cid: string) {
  const all = await getStore().hgetall<{ name: string; joined: number }>('cmembers:' + cid);
  return Object.entries(all).map(([vid, m]) => ({ id: vid, name: m.name, joined: m.joined })).sort((a, b) => a.joined - b.joined);
}
export async function isMember(cid: string, who: string) { return !!(await getStore().hget('cmembers:' + cid, who)); }

export async function addPost(cid: string, by: Author, text: string) {
  const body = cleanLong(text, 600);
  if (body.length < 1) throw new Error('Write something first.');
  if (!(await getStore().hget('communities', cid))) throw new Error('Community not found.');
  const post: Post = { id: id('p'), community: cid, text: body, by, created: Date.now() };
  await getStore().pushCapped('cposts:' + cid, post, 200);
  return post;
}
export async function readPosts(cid: string, limit = 50) {
  return getStore().tail<Post>('cposts:' + cid, Math.max(1, Math.min(200, limit)));
}

export async function createRequest(cid: string, by: Author, input: { title: unknown; details: unknown; wantsContact: unknown }) {
  const title = clean(input.title, 90), details = cleanLong(input.details, 600);
  if (title.length < 4) throw new Error('Say what you need in a few words.');
  if (!(await getStore().hget('communities', cid))) throw new Error('Community not found.');
  const request: Request = { id: id('r'), community: cid, title, details, wantsContact: !!input.wantsContact, by, created: Date.now(), status: 'open', replies: 0 };
  await getStore().hset('creqs:' + cid, request.id, request);
  await getStore().hset('reqindex', request.id, cid);
  await getStore().pushCapped('myreqs:' + by.id, { community: cid, request: request.id }, 100);
  return request;
}

/** Requests in a community, newest first. Contacts are never part of this list. */
export async function listRequests(cid: string) {
  const all = Object.values(await getStore().hgetall<Request>('creqs:' + cid));
  return all.sort((a, b) => (a.status === b.status ? b.created - a.created : a.status === 'open' ? -1 : 1)).slice(0, 100);
}

/**
 * One request with its replies. Contacts are included only for the requester
 * (`viewer` is the owner's visitor id, for people and for their agents).
 */
export async function getRequest(rid: string, viewer: string) {
  const cid = await getStore().hget<string>('reqindex', rid);
  const request = cid ? await getStore().hget<Request>('creqs:' + cid, rid) : null;
  if (!cid || !request) return null;
  const owner = request.by.id === viewer;
  const replies = (await getStore().tail<Reply>('creplies:' + rid, 100)).map(r => owner || r.by.id === viewer ? r
    : { ...r, contact: undefined, sharedContact: !!r.contact });
  return { request, replies, owner };
}

export async function replyTo(rid: string, by: Author, input: { message: unknown; contact: unknown }) {
  const cid = await getStore().hget<string>('reqindex', rid);
  const request = cid ? await getStore().hget<Request>('creqs:' + cid, rid) : null;
  if (!cid || !request) throw new Error('Request not found.');
  if (request.status !== 'open') throw new Error('This request is closed.');
  if (request.by.id === by.id) throw new Error('This is your own request.');
  const message = cleanLong(input.message, 400) || 'I can help.';
  const contact = clean(input.contact, 80) || undefined;
  const reply: Reply = { id: id('y'), request: rid, message, contact, by, created: Date.now() };
  await getStore().pushCapped('creplies:' + rid, reply, 100);
  await getStore().hset('creqs:' + cid, rid, { ...request, replies: request.replies + 1 });
  return { ...reply, contact: undefined, sharedContact: !!contact };
}

export async function closeRequest(rid: string, owner: string) {
  const cid = await getStore().hget<string>('reqindex', rid);
  const request = cid ? await getStore().hget<Request>('creqs:' + cid, rid) : null;
  if (!cid || !request) throw new Error('Request not found.');
  if (request.by.id !== owner) throw new Error('Only the person who asked can close it.');
  await getStore().hset('creqs:' + cid, rid, { ...request, status: 'done' });
}

export async function myRequests(owner: string) {
  const refs = await getStore().tail<{ community: string; request: string }>('myreqs:' + owner, 100);
  const found = await Promise.all(refs.map(r => getStore().hget<Request>('creqs:' + r.community, r.request)));
  return found.filter((r): r is Request => !!r).reverse();
}

// ---------------------------------------------------------------- presence (opt-in)
interface Presence { name: string; lat: number; lng: number; seen: number }
const coarse = (v: number) => Math.round(v * 200) / 200; // ~500 m grid: exact positions are never stored

export async function nearbyPeople(at: { lat: number; lng: number }, self?: string, radiusKm = 5) {
  const all = await getStore().hgetall<Presence>('presence');
  const now = Date.now();
  const stale = Object.keys(all).filter(k => now - all[k].seen > PRESENCE_TTL);
  if (stale.length) void getStore().hdel('presence', ...stale);
  return Object.entries(all)
    .filter(([k, p]) => k !== self && now - p.seen <= PRESENCE_TTL && km(at, p) <= radiusKm)
    .map(([k, p]) => ({ id: k.slice(-8), name: p.name, km: Math.max(0.5, Math.round(km(at, p) * 2) / 2) }))
    .sort((a, b) => a.km - b.km).slice(0, 50);
}

/** What other people may see of an author: the name and the agent label, never the visitor id. */
export const publicAuthor = (a: Author) => ({ name: a.name, agent: a.agent });
export const publicCommunity = (c: Community) => ({ ...c, by: publicAuthor(c.by) });
export const publicPost = (p: Post) => ({ ...p, by: publicAuthor(p.by) });

// ---------------------------------------------------------------- HTTP routes for people
export async function readJson(req: IncomingMessage, limit = 8000): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw new Error('Request too large'); }
  return raw ? JSON.parse(raw) : {};
}

export function communitiesApi() {
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    if (!(path === '/api/me' || path.startsWith('/api/communities') || path === '/api/presence' || path === '/api/requests/mine')) return next();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const ip = clientIp(req.headers, req.socket?.remoteAddress);
    try {
      const me = await visitor(req, res);
      const author: Author = { id: me.id, name: me.name };
      const limit = async (key: string, n: number, window: number) => (await allow(`${key}:${me.id}`, n, window)) && (await allow(`${key}:ip:${ip}`, n * 3, window));

      if (path === '/api/me') {
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!(await limit('rename', 20, 3600))) return send(429, { error: 'Too many name changes. Try later.' });
          return send(200, { id: me.id, name: await rename(me.id, String(body.name ?? '')) });
        }
        return send(200, { id: me.id, name: me.name, communities: Object.keys(await getStore().hgetall('mycomms:' + me.id)) });
      }

      if (path === '/api/presence') {
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!(await limit('presence', 120, 3600))) return send(429, { error: 'Slow down.' });
          if (body.on === false) { await getStore().hdel('presence', me.id); return send(200, { on: false }); }
          const lat = Number(body.lat), lng = Number(body.lng);
          if (!validPoint(lat, lng)) return send(400, { error: 'lat and lng required' });
          await getStore().hset('presence', me.id, { name: me.name, lat: coarse(lat), lng: coarse(lng), seen: Date.now() });
          return send(200, { on: true });
        }
        const lat = Number(url.searchParams.get('lat') ?? NaN), lng = Number(url.searchParams.get('lng') ?? NaN);
        if (!validPoint(lat, lng)) return send(400, { error: 'lat and lng required' });
        const people = await nearbyPeople({ lat, lng }, me.id);
        return send(200, { count: people.length, people });
      }

      if (path === '/api/requests/mine' && req.method === 'GET') return send(200, { requests: await myRequests(me.id) });

      if (path === '/api/communities') {
        if (req.method === 'GET') {
          const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
          // Only use a centre when both are given (Number(null) would be 0, the middle of the Atlantic).
          const lat = url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : NaN;
          const lng = url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : NaN;
          const mine = await getStore().hgetall('mycomms:' + me.id);
          const list = await findCommunities({
            bbox: bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : undefined,
            lat: Number.isFinite(lat) ? lat : undefined, lng: Number.isFinite(lng) ? lng : undefined,
            radiusKm: Number(url.searchParams.get('radius')) || 25, query: url.searchParams.get('q') ?? '',
          });
          return send(200, { communities: list.map(c => ({ ...publicCommunity(c), joined: c.id in mine, mine: c.by.id === me.id })) });
        }
        if (req.method === 'POST') {
          if (!(await limit('community', 5, 86400))) return send(429, { error: 'You can start 5 communities a day.' });
          return send(201, { community: { ...publicCommunity(await createCommunity(author, await readJson(req))), joined: true, mine: true } });
        }
      }

      const match = path.match(/^\/api\/communities\/(k[a-f0-9]{12})(?:\/(join|leave|posts|requests)(?:\/(r[a-f0-9]{12})(?:\/(replies|close))?)?)?$/);
      if (!match) return send(404, { error: 'Unknown route' });
      const [, cid, action, rid, sub] = match;

      if (!action && req.method === 'GET') {
        const community = await getCommunity(cid);
        if (!community) return send(404, { error: 'Community not found.' });
        const list = await members(cid);
        return send(200, {
          community: publicCommunity(community), joined: list.some(m => m.id === me.id), members: list.slice(0, 60).map(m => ({ name: m.name, joined: m.joined, me: m.id === me.id })),
          posts: (await readPosts(cid, 60)).map(p => ({ ...publicPost(p), mine: p.by.id === me.id })),
          requests: (await listRequests(cid)).map(r => ({ ...r, mine: r.by.id === me.id, by: publicAuthor(r.by) })),
        });
      }
      if (action === 'join' && req.method === 'POST') {
        if (!(await limit('join', 60, 3600))) return send(429, { error: 'Slow down.' });
        await join(cid, author); return send(200, { joined: true, members: await getStore().hlen('cmembers:' + cid) });
      }
      if (action === 'leave' && req.method === 'POST') { await leave(cid, me.id); return send(200, { joined: false }); }
      if (action === 'posts' && req.method === 'POST') {
        if (!(await isMember(cid, me.id))) return send(403, { error: 'Join the community to post.' });
        if (!(await limit('post', 30, 3600))) return send(429, { error: 'You are posting quickly. Wait a little.' });
        const body = await readJson(req);
        const post = await addPost(cid, author, String(body.text ?? ''));
        return send(201, { post: { ...publicPost(post), mine: true } });
      }
      if (action === 'requests' && !rid && req.method === 'POST') {
        if (!(await isMember(cid, me.id))) return send(403, { error: 'Join the community to ask.' });
        if (!(await limit('request', 10, 86400))) return send(429, { error: 'You can post 10 requests a day.' });
        const body = await readJson(req);
        const request = await createRequest(cid, author, { title: body.title, details: body.details, wantsContact: body.wantsContact });
        return send(201, { request: { ...request, by: publicAuthor(request.by), mine: true } });
      }
      if (action === 'requests' && rid && !sub && req.method === 'GET') {
        const found = await getRequest(rid, me.id);
        if (!found || found.request.community !== cid) return send(404, { error: 'Request not found.' });
        return send(200, { ...found, request: { ...found.request, by: publicAuthor(found.request.by) },
          replies: found.replies.map(r => ({ ...r, by: publicAuthor(r.by), mine: r.by.id === me.id })) });
      }
      if (action === 'requests' && rid && sub === 'replies' && req.method === 'POST') {
        if (!(await limit('reply', 30, 3600))) return send(429, { error: 'Slow down.' });
        const body = await readJson(req);
        const reply = await replyTo(rid, author, { message: body.message, contact: body.contact });
        return send(201, { reply: { ...reply, by: publicAuthor(reply.by), mine: true } });
      }
      if (action === 'requests' && rid && sub === 'close' && req.method === 'POST') { await closeRequest(rid, me.id); return send(200, { ok: true }); }
      return send(404, { error: 'Unknown route' });
    } catch (error) {
      return send(400, { error: (error as Error).message || 'Bad request' });
    }
  };
}
