import type { CityConfig } from '../types';
import type { ChatIdentity, ChatMessage, ChatService } from './types';

/** Local stand-in for Nexconn. Rooms live in localStorage; other tabs get messages via BroadcastChannel. */
export function createMockChat(city: CityConfig): ChatService {
  let me: ChatIdentity | null = null;
  let room: string | null = null;
  let listener: ((m: ChatMessage) => void) | null = null;
  const bus = 'BroadcastChannel' in window ? new BroadcastChannel('nearby-demo-chat') : null;
  bus?.addEventListener('message', (e) => { const m = e.data as ChatMessage; if (m.roomId === room) listener?.(m); });

  const key = (r: string) => `nearby.demo.${r}`;
  const stored = (r: string): ChatMessage[] => { try { return JSON.parse(localStorage.getItem(key(r)) || '[]'); } catch { return []; } };
  const seed = (r: string): ChatMessage[] => {
    const areaId = r.slice(r.lastIndexOf('_') + 1);
    const now = Date.now();
    return city.chats.filter((c) => c.areaId === areaId).map((c, i, all) => ({
      id: `seed-${r}-${i}`, roomId: r, userId: `seed-${c.name}`, name: c.name, text: c.text, at: now - (all.length - i) * 6 * 60_000,
    }));
  };

  return {
    mode: 'demo',
    label: 'demo chat',
    async connect(who) { me = who; },
    async ensureRoom() {},
    async join(r, onMessage) { room = r; listener = onMessage; return seed(r).concat(stored(r)).slice(-30); },
    async leave() { room = null; listener = null; },
    async send(r, text) {
      if (!me) throw new Error('not connected');
      const m: ChatMessage = { id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`, roomId: r, userId: me.userId, name: me.name, text, at: Date.now() };
      try { localStorage.setItem(key(r), JSON.stringify(stored(r).concat(m).slice(-50))); } catch { /* session only */ }
      bus?.postMessage(m);
      return m;
    },
  };
}
