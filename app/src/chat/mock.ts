import type { ChatIdentity, ChatMessage, ChatRoom, ChatService, RoomEvents } from './types';

export function createMockChat(): ChatService {
  let me: ChatIdentity;
  let room: ChatRoom | null = null;
  let events: RoomEvents | null = null;
  const messagesKey = (id: string) => 'nearby.demo.' + id;
  const metaPrefix = (id: string) => 'nearby.meta.' + id + '.';
  const history = (id: string): ChatMessage[] => JSON.parse(localStorage.getItem(messagesKey(id)) || '[]');
  function syncMetadata() {
    if (!room) return;
    const prefix = metaPrefix(room.id);
    const entries = Object.keys(localStorage).filter(key => key.startsWith(prefix));
    events?.metadata(Object.fromEntries(entries.map(key => [key.slice(prefix.length), localStorage.getItem(key)!])));
  }
  window.addEventListener('storage', ({key}) => {
    if (!room || !key) return;
    if (key.startsWith(metaPrefix(room.id))) syncMetadata();
    if (key === messagesKey(room.id)) history(room.id).forEach(message => events?.message(message));
  });
  function check(id: string) {
    if (room?.id !== id) throw new Error('Room changed');
  }
  return {
    mode: 'demo',
    async connect(who) { me = who; return who; },
    async join(next, callbacks) {
      room = next; events = callbacks;
      const seed = next.demoMessages ?? [];
      seed.forEach((m,i) => callbacks.message({...m, id: 'seed-' + i, roomId: next.id, userId: 'seed-' + m.name, at: Date.now() - (seed.length-i)*360000}));
      history(next.id).forEach(callbacks.message);
      syncMetadata();
      callbacks.availability(true);
    },
    async leave() { room = null; events = null; },
    async send(id, text, file) {
      let image: string | undefined;
      if (file) image = await new Promise<string>((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read photo'));
        reader.readAsDataURL(file);
      });
      check(id);
      const msg = {id: crypto.randomUUID(), roomId: id, userId: me.userId, name: me.name, at: Date.now(), text, image};
      // Serialize same-origin demo writers so simultaneous tabs keep both posts.
      const persist = () => localStorage.setItem(messagesKey(id), JSON.stringify([...history(id), msg].slice(-50)));
      if (navigator.locks) await navigator.locks.request(messagesKey(id), persist); else persist();
      return msg;
    },
    async write(id, key, value) {
      check(id);
      if (value === null) localStorage.removeItem(metaPrefix(id) + key);
      else localStorage.setItem(metaPrefix(id) + key, value);
      syncMetadata();
    },
  };
}
