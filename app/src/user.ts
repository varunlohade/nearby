export interface User { userId: string; name: string; areaId: string }

const KEY = 'nearby.user';

export function loadUser(): User | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

export function saveUser(name: string, areaId: string, prev?: User | null): User {
  const userId = prev?.userId ?? (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'u') + Math.random().toString(36).slice(2, 10);
  const u = { userId, name: name.trim().slice(0, 40), areaId };
  try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* session only */ }
  return u;
}

export function guestId(): string {
  try {
    let g = localStorage.getItem('nearby.guest');
    if (!g) { g = 'guest' + Math.random().toString(36).slice(2, 10); localStorage.setItem('nearby.guest', g); }
    return g;
  } catch { return 'guest' + Math.random().toString(36).slice(2, 10); }
}
