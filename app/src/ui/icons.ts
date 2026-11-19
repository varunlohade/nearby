import type { HappeningKind } from '../types';

const svg = (s: number, body: string, fill = 'none') =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  area: (s = 18) => svg(s, '<path d="M4 7.5 10 4l7 2.5 3 6-2.5 6.5-7.5 1.5L4 16z"/>'),
  chat: svg(15, '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  people: svg(15, '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  pin: svg(15, '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  clock: svg(15, '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  x: svg(14, '<path d="M6 6l12 12M18 6 6 18"/>'),
  lock: svg(14, '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  send: svg(18, '<path d="M5 12h13M13 6l6 6-6 6"/>'),
  locate: svg(16, '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
};

export const KIND: Record<HappeningKind, { label: string; color: string; icon: string }> = {
  concert: { label: 'Concert', color: '#C2537A', icon: svg(14, '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>') },
  market: { label: 'Market', color: '#4E8B3A', icon: svg(14, '<path d="M4 9h16l-1.5-5h-13zM5 9v11h14V9M9 20v-6h6v6"/>') },
  match: { label: 'Match', color: '#3A78C9', icon: svg(14, '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l4 3-1.5 4.5h-5L8 10.5z"/>') },
  ride: { label: 'Run / ride', color: '#2E7D9B', icon: svg(14, '<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9 8.5 6H6"/>') },
  help: { label: 'Help post', color: '#B5533C', icon: svg(14, '<path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z"/>') },
  joined: { label: 'People joined', color: '#FFB224', icon: svg(14, '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>') },
};

export const LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7.5 10 4l7 2.5 3 6-2.5 6.5-7.5 1.5L4 16z" fill="#FFB224"/></svg>`;

const PALETTE = ['#7C5CDB', '#2F8F83', '#C2537A', '#3A78C9', '#9A6B2F', '#4E8B3A', '#B5533C', '#5B6478', '#7A4FA0', '#2E7D9B'];
const NAMES = ['Meera', 'Arjun', 'Nisha', 'Kabir', 'Rohan', 'Ananya', 'Farah', 'Dev', 'Ishaan', 'Tara'];

export const colorFor = (s: string) => PALETTE[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const av = (name: string, cls = 'av') => `<div class="${cls}" style="background:${colorFor(name)}">${esc(name[0]?.toUpperCase() ?? '?')}</div>`;
export const stack = (n: number, off = 0) => `<div class="stack">${NAMES.slice(off % 6, (off % 6) + n).map((p) => av(p)).join('')}</div>`;
