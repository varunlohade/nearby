import { getStore } from './store.js';

interface Player {
  id: string; name: string; lat: number; lng: number; seen: number;
}
const windowMs = 12000;
const key = (band: number, window: number) => 'roam:players:' + band + ':' + window;

// Short-lived latitude bands cover nearby avatars on both sides of a tile boundary.
// Clients send their character's virtual position; the browser's GPS is never queried here.
export async function roamPlayers(id: string, input: Record<string, unknown>) {
  const { lat, lng, session, name } = input;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180 ||
      typeof session !== 'string' || !/^[a-zA-Z0-9-]{1,48}$/.test(session)) return null;
  const now = Date.now(), window = Math.floor(now / windowMs), band = Math.floor(lat);
  const store = getStore();
  const field = id + ':' + session;
  const bands = Array.from(new Set([band, Math.floor(lat - .005), Math.floor(lat + .005)]));
  const keys = bands.flatMap(b => [key(b, window - 1), key(b, window)]);
  if (input.leave === true) {
    await Promise.all(keys.map(k => store.hdel(k, field)));
    return [];
  }
  const player: Player = {id, name: String(name || 'Neighbour').slice(0, 40), lat, lng, seen: now};
  await store.hset(key(band, window), field, player, 30);
  const rows = await Promise.all(keys.map(k => store.hgetall<Player>(k)));
  const latest = new Map<string, Player>();
  for (const batch of rows) for (const p of Object.values(batch)) {
    if (p.id !== id && now - p.seen < windowMs && p.seen > (latest.get(p.id)?.seen ?? 0)) latest.set(p.id, p);
  }
  const mx = 111320 * Math.cos(lat * Math.PI / 180);
  return Array.from(latest.values(), p => ({
    id: p.id, name: p.name, lng: p.lng, lat: p.lat,
    distance: Math.hypot((p.lat - lat) * 110574, ((p.lng - lng + 540) % 360 - 180) * mx),
  })).filter(p => p.distance <= 500).sort((a,b) => a.distance - b.distance).slice(0, 24);
}
