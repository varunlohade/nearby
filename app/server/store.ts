// Shared state for the API: created places, rate limits and the audio handshake.
//
// On Vercel, function instances share nothing in memory, so state lives in Redis:
// a Railway Redis over TCP (REDIS_URL), or Upstash over REST (KV_REST_API_URL).
// Locally, without either, an in-memory store with the same operations keeps
// `npm run dev` working.

import { Redis } from '@upstash/redis';
import IORedis from 'ioredis';

export interface Store {
  readonly shared: boolean;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Increment a counter; the first increment starts its time window. */
  incrWindow(key: string, windowSeconds: number): Promise<number>;
  hset(key: string, field: string, value: unknown): Promise<void>;
  hgetall<T>(key: string): Promise<Record<string, T>>;
  hdel(key: string, ...fields: string[]): Promise<void>;
  rpush(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Read and clear a list in one step. */
  drain<T>(key: string): Promise<T[]>;
  /** Append to a list and keep only its newest `cap` items. */
  pushCapped(key: string, value: unknown, cap: number): Promise<void>;
  /** The newest `count` items of a list, oldest first. */
  tail<T>(key: string, count: number): Promise<T[]>;
  hget<T>(key: string, field: string): Promise<T | null>;
  hlen(key: string): Promise<number>;
}

function redisStore(redis: Redis): Store {
  return {
    shared: true,
    async get<T>(key: string) { return (await redis.get<T>(key)) ?? null; },
    async set(key, value, ttl) { if (ttl) await redis.set(key, value, { ex: ttl }); else await redis.set(key, value); },
    async del(...keys) { if (keys.length) await redis.del(...keys); },
    async incrWindow(key, window) {
      const [count] = await redis.multi().incr(key).expire(key, window, 'NX').exec<[number, number]>();
      return count;
    },
    async hset(key, field, value) { await redis.hset(key, { [field]: value }); },
    async hgetall<T>(key: string) { return ((await redis.hgetall<Record<string, T>>(key)) ?? {}) as Record<string, T>; },
    async hdel(key, ...fields) { if (fields.length) await redis.hdel(key, ...fields); },
    async rpush(key, value, ttl) { await redis.multi().rpush(key, value).expire(key, ttl).exec(); },
    async drain<T>(key: string) {
      const [items] = await redis.multi().lrange(key, 0, -1).del(key).exec<[T[], number]>();
      return items ?? [];
    },
    async pushCapped(key, value, cap) { await redis.multi().rpush(key, value).ltrim(key, -cap, -1).exec(); },
    async tail<T>(key: string, count: number) { return ((await redis.lrange<T>(key, -count, -1)) ?? []) as T[]; },
    async hget<T>(key: string, field: string) { return ((await redis.hget<T>(key, field)) ?? null) as T | null; },
    async hlen(key) { return Number(await redis.hlen(key)); },
  };
}

/** Redis over TCP (Railway). Values are stored as JSON strings. */
function tcpStore(redis: IORedis): Store {
  const enc = (value: unknown) => JSON.stringify(value);
  const dec = <T>(raw: string | null): T | null => { if (raw == null) return null; try { return JSON.parse(raw) as T; } catch { return raw as T; } };
  return {
    shared: true,
    async get<T>(key: string) { return dec<T>(await redis.get(key)); },
    async set(key, value, ttl) { if (ttl) await redis.set(key, enc(value), 'EX', ttl); else await redis.set(key, enc(value)); },
    async del(...keys) { if (keys.length) await redis.del(...keys); },
    async incrWindow(key, window) {
      const result = await redis.multi().incr(key).expire(key, window, 'NX').exec();
      return Number(result?.[0]?.[1] ?? 0);
    },
    async hset(key, field, value) { await redis.hset(key, field, enc(value)); },
    async hgetall<T>(key: string) {
      const raw = await redis.hgetall(key);
      return Object.fromEntries(Object.entries(raw).map(([f, v]) => [f, dec<T>(v) as T]));
    },
    async hdel(key, ...fields) { if (fields.length) await redis.hdel(key, ...fields); },
    async rpush(key, value, ttl) { await redis.multi().rpush(key, enc(value)).expire(key, ttl).exec(); },
    async drain<T>(key: string) {
      const result = await redis.multi().lrange(key, 0, -1).del(key).exec();
      return ((result?.[0]?.[1] as string[]) ?? []).map(v => dec<T>(v) as T);
    },
    async pushCapped(key, value, cap) { await redis.multi().rpush(key, enc(value)).ltrim(key, -cap, -1).exec(); },
    async tail<T>(key: string, count: number) { return (await redis.lrange(key, -count, -1)).map(v => dec<T>(v) as T); },
    async hget<T>(key: string, field: string) { return dec<T>(await redis.hget(key, field)); },
    async hlen(key) { return redis.hlen(key); },
  };
}

function memoryStore(): Store {
  const values = new Map<string, { value: unknown; until: number }>();
  const live = (key: string) => {
    const hit = values.get(key);
    if (hit && hit.until && hit.until < Date.now()) { values.delete(key); return undefined; }
    return hit;
  };
  const put = (key: string, value: unknown, ttl?: number) => values.set(key, { value, until: ttl ? Date.now() + ttl * 1000 : 0 });
  return {
    shared: false,
    async get<T>(key: string) { return (live(key)?.value as T) ?? null; },
    async set(key, value, ttl) { put(key, structuredClone(value), ttl); },
    async del(...keys) { keys.forEach(k => values.delete(k)); },
    async incrWindow(key, window) {
      const hit = live(key);
      const next = Number(hit?.value ?? 0) + 1;
      values.set(key, { value: next, until: hit?.until || Date.now() + window * 1000 });
      return next;
    },
    async hset(key, field, value) {
      const hash = (live(key)?.value as Record<string, unknown>) ?? {};
      hash[field] = structuredClone(value);
      put(key, hash);
    },
    async hgetall<T>(key: string) { return structuredClone((live(key)?.value as Record<string, T>) ?? {}); },
    async hdel(key, ...fields) {
      const hash = live(key)?.value as Record<string, unknown> | undefined;
      fields.forEach(f => { if (hash) delete hash[f]; });
    },
    async rpush(key, value, ttl) {
      const list = (live(key)?.value as unknown[]) ?? [];
      list.push(structuredClone(value));
      put(key, list, ttl);
    },
    async drain<T>(key: string) {
      const list = (live(key)?.value as T[]) ?? [];
      values.delete(key);
      return list;
    },
    async pushCapped(key, value, cap) {
      const list = (live(key)?.value as unknown[]) ?? [];
      list.push(structuredClone(value));
      put(key, list.slice(-cap));
    },
    async tail<T>(key: string, count: number) { return structuredClone(((live(key)?.value as T[]) ?? []).slice(-count)); },
    async hget<T>(key: string, field: string) { return structuredClone(((live(key)?.value as Record<string, T>) ?? {})[field] ?? null); },
    async hlen(key) { return Object.keys((live(key)?.value as object) ?? {}).length; },
  };
}

let store: Store | undefined;
export function getStore(): Store {
  if (store) return store;
  const tcp = process.env.REDIS_URL;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (tcp) {
    // One connection per function instance, reused across requests (Fluid Compute).
    const client = new IORedis(tcp, { maxRetriesPerRequest: 2, connectTimeout: 5000, enableAutoPipelining: true });
    client.on('error', error => console.error('[store] redis', error.message));
    store = tcpStore(client);
  } else store = url && token ? redisStore(new Redis({ url, token })) : memoryStore();
  if (!store.shared && process.env.VERCEL) console.warn('[store] No Redis keys: using memory, which is not shared between instances.');
  return store;
}

/** The caller's IP as Vercel reports it (first hop of x-forwarded-for). */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback = 'local') {
  const forwarded = headers['x-real-ip'] ?? headers['x-forwarded-for'];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? fallback).split(',')[0].trim() || fallback;
}

/** Fixed-window rate limit. Returns true when the call is allowed. */
export async function allow(key: string, limit: number, windowSeconds: number, failOpen = true) {
  try { return (await getStore().incrWindow('rl:' + key, windowSeconds)) <= limit; }
  catch (error) { console.error('[rate-limit]', error); return failOpen; }
}
