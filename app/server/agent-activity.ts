import { getStore } from './store.js';

const windowMs = 15 * 60_000;
const bucket = (at: number) => 'area-agents:' + Math.floor(at / windowMs);
interface Visit { kind: string; lat: number; lng: number; seen: number }

export async function recordAgentVisit(keyId: string, kind: string, lat: number, lng: number) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 85 || !Number.isFinite(lng) || Math.abs(lng) > 180) return;
  const seen = Date.now();
  await getStore().hset(bucket(seen), keyId, {
    kind, lat: Math.round(lat * 200) / 200, lng: Math.round(lng * 200) / 200, seen,
  }, 1800);
}

export async function recentAgentVisits() {
  const now = Date.now();
  const [previous, current] = await Promise.all([now - windowMs, now].map(at => getStore().hgetall<Visit>(bucket(at))));
  return Object.values({ ...previous, ...current }).filter(visit => now - visit.seen < windowMs);
}
