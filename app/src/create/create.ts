// Create anything, anywhere on the map: a chat room, an event or a live audio
// session. Two taps: pick a spot (tap "+ Create", right-click, or long-press),
// pick what to make, give it a name, and it opens.
//
// Items live in the app server's geo registry (server/places.ts) and are
// fetched for the map viewport, so anyone looking at that spot sees them.

import maplibregl from 'maplibre-gl';
import './create.css';
import type { Place } from '../world/earth';
import { AudioSession } from './audio';

export interface Created {
  id: string; kind: 'room' | 'event' | 'audio'; title: string; lat: number; lng: number; place: string;
  start?: number; category?: string; by: string; created: number; expires: number; live?: number;
}

interface CreateOptions {
  map: () => maplibregl.Map;
  place: () => Place | undefined;
  user: () => { userId: string; name: string };
  /** Open a Nexconn room in the app's chat panel. */
  openChat: (roomId: string, title: string, kind: string) => void;
  /** Items near the current area, for the activity list. */
  onNearby: (items: Created[]) => void;
}

const KINDS = {
  room: { label: 'Chat room', verb: 'Start a chat room', hint: 'A text channel pinned here', icon: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/></svg>' },
  event: { label: 'Event', verb: 'Host an event', hint: 'A time and place people can join', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="1"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="m9 15 2 2 4-4"/></svg>' },
  audio: { label: 'Audio session', verb: 'Go live with audio', hint: 'Talk with up to 6 people here', icon: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>' },
} as const;
const CATEGORY_LABEL: Record<string, string> = { talk: 'Talk', sport: 'Sport', culture: 'Music', social: 'Meetup', wellness: 'Outdoors', help: 'Community' };

const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const instant = () => document.documentElement.classList.contains('instant');
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const kmFrom = (place: Place | undefined, c: { lat: number; lng: number }) => place ? new maplibregl.LngLat(place.lng, place.lat).distanceTo(new maplibregl.LngLat(c.lng, c.lat)) / 1000 : 0;
function nextHour() {
  const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function mountCreate(options: CreateOptions) {
  const items = new Map<string, Created>();
  const markers = new Map<string, maplibregl.Marker>();
  let popup: maplibregl.Popup | undefined;
  let audio: AudioSession | undefined;
  let audioItem: Created | undefined;
  let fetchTimer = 0;
  let fetchSeq = 0;

  // ------------------------------------------------------------ "+ Create" mode
  const bar = document.createElement('div');
  bar.className = 'create-bar';
  bar.hidden = true;
  bar.innerHTML = `<span class="create-bar-text"><b>Create something here</b><small>Tap any spot on the map, or use the centre</small></span>
    <button type="button" data-act="center">Use map centre</button><button type="button" data-act="cancel">Cancel</button>`;
  const crosshair = document.createElement('div');
  crosshair.className = 'create-crosshair';
  crosshair.setAttribute('aria-hidden', 'true');
  document.querySelector('#app')!.append(bar, crosshair);

  const audioPanel = document.createElement('aside');
  audioPanel.className = 'audio-panel';
  audioPanel.hidden = true;
  audioPanel.setAttribute('aria-label', 'Live audio session');
  document.querySelector('#app')!.append(audioPanel);

  function start() {
    closePopup();
    document.body.classList.add('creating');
    bar.hidden = false;
  }
  function stop() {
    document.body.classList.remove('creating');
    bar.hidden = true;
  }
  bar.querySelector<HTMLButtonElement>('[data-act=center]')!.onclick = () => menu(options.map().getCenter().wrap());
  bar.querySelector<HTMLButtonElement>('[data-act=cancel]')!.onclick = stop;

  const map = options.map();
  map.on('click', event => {
    if (!document.body.classList.contains('creating')) return;
    if ((event.originalEvent.target as Element).closest('.maplibregl-marker, .maplibregl-popup')) return;
    menu(event.lngLat.wrap());
  });
  map.on('contextmenu', event => { event.preventDefault(); menu(event.lngLat.wrap()); });

  // Long-press on touch screens opens the same menu.
  let press = 0, pressAt: { x: number; y: number } | undefined;
  const canvas = map.getCanvasContainer();
  canvas.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { clearTimeout(press); return; }
    const t = event.touches[0], rect = canvas.getBoundingClientRect();
    pressAt = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    clearTimeout(press);
    press = window.setTimeout(() => { if (pressAt) { navigator.vibrate?.(15); menu(map.unproject([pressAt.x, pressAt.y]).wrap()); } }, 550);
  }, { passive: true });
  canvas.addEventListener('touchmove', event => {
    const t = event.touches[0], rect = canvas.getBoundingClientRect();
    if (pressAt && Math.hypot(t.clientX - rect.left - pressAt.x, t.clientY - rect.top - pressAt.y) > 10) { clearTimeout(press); pressAt = undefined; }
  }, { passive: true });
  canvas.addEventListener('touchend', () => { clearTimeout(press); pressAt = undefined; });

  // ------------------------------------------------------------ menu and forms
  function closePopup() { popup?.remove(); popup = undefined; document.body.classList.remove('create-open'); }

  function show(at: maplibregl.LngLat, content: HTMLElement, className: string) {
    closePopup();
    popup = new maplibregl.Popup({ anchor: 'bottom', offset: [0, -14], className, closeButton: false, closeOnClick: false, focusAfterOpen: false, maxWidth: 'none' })
      .setLngLat(at).setDOMContent(content).addTo(options.map());
    document.body.classList.add('create-open');
    const mine = popup;
    popup.on('close', () => { if (popup === mine || !popup) document.body.classList.remove('create-open'); });
    const compact = innerWidth <= 720;
    options.map().easeTo({ center: at, offset: [compact ? 0 : 120, compact ? 60 : 140], duration: instant() ? 0 : 400 });
  }

  function menu(at: maplibregl.LngLat) {
    stop();
    const card = document.createElement('div');
    card.className = 'create-card';
    card.innerHTML = `
      <header><span class="create-kicker">Create here</span><button type="button" class="create-x" aria-label="Close">×</button></header>
      <p class="create-where">Finding this spot…</p>
      <div class="create-choices">
        <button type="button" class="create-choice kind-community" data-community><i><svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0M10.5 20a5.5 5.5 0 0 1 11 0"/></svg></i><span><b>Start a community</b><small>A lasting group for neighbours, with a board and requests</small></span></button>${(Object.keys(KINDS) as (keyof typeof KINDS)[]).map(k => `
        <button type="button" class="create-choice kind-${k}" data-kind="${k}"><i>${KINDS[k].icon}</i><span><b>${KINDS[k].verb}</b><small>${KINDS[k].hint}</small></span></button>`).join('')}
      </div>`;
    let where = '';
    void fetch(`/api/places/where?lat=${at.lat}&lng=${at.lng}`).then(r => r.json()).then(d => {
      where = d.place || ''; const p = card.querySelector('.create-where'); if (p) p.textContent = where ? '⌖ ' + where : '';
    }).catch(() => { const p = card.querySelector('.create-where'); if (p) p.textContent = ''; });
    card.querySelector<HTMLButtonElement>('.create-x')!.onclick = closePopup;
    card.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(b => { b.onclick = () => form(b.dataset.kind as Created['kind'], at, () => where); });
    // Communities live in src/community/community.ts; hand the spot over.
    card.querySelector<HTMLButtonElement>('[data-community]')!.onclick = () => {
      closePopup();
      document.dispatchEvent(new CustomEvent('nearby:create-community', { detail: { lat: at.lat, lng: at.lng, where } }));
    };
    show(at, card, 'create-popup');
    const pin = document.createElement('div');
    pin.className = 'create-spot';
    const spot = new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat(at).addTo(options.map());
    popup!.on('close', () => spot.remove());
  }

  function form(kind: Created['kind'], at: maplibregl.LngLat, where: () => string) {
    const area = options.place()?.locality ?? 'this spot';
    const card = document.createElement('form');
    card.className = 'create-card create-form kind-' + kind;
    const suggestion = kind === 'room' ? `${area} neighbours` : kind === 'audio' ? `Evening chat in ${area}` : '';
    card.innerHTML = `
      <header><span class="create-kicker"><i>${KINDS[kind].icon}</i>${KINDS[kind].label}</span><button type="button" class="create-x" aria-label="Close">×</button></header>
      <label><span>Name</span><input name="title" required minlength="2" maxlength="60" value="${esc(suggestion)}" placeholder="${kind === 'event' ? 'Sunday football, book swap…' : 'Give it a name'}" /></label>
      ${kind === 'event' ? `
      <div class="create-row">
        <label><span>Starts</span><input name="start" type="datetime-local" required value="${nextHour()}" /></label>
        <label><span>Type</span><select name="category">${Object.entries(CATEGORY_LABEL).map(([v, l]) => `<option value="${v}"${v === 'social' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>` : ''}
      ${kind === 'audio' ? '<p class="create-note">Peer-to-peer live audio for up to 6 people. Your mic is shared only while you are in the session. Nothing is recorded.</p>' : ''}
      <p class="create-where">${esc(where() ? '⌖ ' + where() : '')}</p>
      <div class="create-actions"><button type="button" class="create-back">Back</button><button type="submit">${kind === 'room' ? 'Create room' : kind === 'event' ? 'Publish event' : 'Go live'}</button></div>
      <small class="create-status" role="status"></small>`;
    card.querySelector<HTMLButtonElement>('.create-x')!.onclick = closePopup;
    card.querySelector<HTMLButtonElement>('.create-back')!.onclick = () => menu(at);
    card.onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(card);
      const submit = card.querySelector<HTMLButtonElement>('button[type=submit]')!;
      const status = card.querySelector<HTMLElement>('.create-status')!;
      submit.disabled = true; status.textContent = 'Creating…';
      try {
        const response = await fetch('/api/places', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind, title: String(data.get('title') ?? ''), lat: at.lat, lng: at.lng, place: where(), by: options.user().name,
            start: kind === 'event' ? new Date(String(data.get('start'))).valueOf() : undefined, category: data.get('category') ?? undefined,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not create it. Try again.');
        add(result.item);
        publishNearby();
        open(result.item.id, true);
      } catch (error) {
        status.textContent = (error as Error).message;
        submit.disabled = false;
      }
    };
    show(at, card, 'create-popup');
    requestAnimationFrame(() => card.querySelector<HTMLInputElement>('input[name=title]')?.select());
  }

  // ------------------------------------------------------------ pins and cards
  function markerFor(item: Created) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `drop kind-${item.kind}`;
    el.dataset.created = item.id;
    el.setAttribute('aria-label', `${KINDS[item.kind].label}: ${item.title}`);
    el.onclick = event => { event.stopPropagation(); open(item.id); };
    return el;
  }
  function paint(item: Created) {
    const el = markers.get(item.id)?.getElement();
    if (!el) return;
    const badge = item.kind === 'audio' ? `<em>${item.live ? item.live + ' live' : 'Live'}</em>` : item.kind === 'event' && item.start ? `<em>${new Date(item.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</em>` : '';
    el.innerHTML = `<span class="drop-face">${KINDS[item.kind].icon}</span>${badge}<span class="drop-name">${esc(item.title)}</span>`;
    el.classList.toggle('is-live', item.kind === 'audio' && !!item.live);
  }
  function add(item: Created) {
    items.set(item.id, item);
    if (!markers.has(item.id)) markers.set(item.id, new maplibregl.Marker({ element: markerFor(item), anchor: 'bottom' }).setLngLat([item.lng, item.lat]).addTo(options.map()));
    paint(item);
  }

  function open(id: string, fresh = false) {
    const item = items.get(id);
    if (!item) return;
    const at = new maplibregl.LngLat(item.lng, item.lat);
    document.querySelectorAll('.drop.is-active').forEach(n => n.classList.remove('is-active'));
    markers.get(id)?.getElement().classList.add('is-active');
    const card = document.createElement('div');
    card.className = 'create-card drop-card kind-' + item.kind;
    const distance = kmFrom(options.place(), item);
    const line = item.kind === 'event' && item.start ? when(item.start) + (item.category ? ' · ' + CATEGORY_LABEL[item.category] : '')
      : item.kind === 'audio' ? (item.live ? `${item.live} talking now` : 'Nobody talking yet') : 'Open chat room';
    card.innerHTML = `
      <header><span class="create-kicker"><i>${KINDS[item.kind].icon}</i>${KINDS[item.kind].label}</span><button type="button" class="create-x" aria-label="Close">×</button></header>
      <h3>${esc(item.title)}</h3>
      <p class="drop-line">${esc(line)}</p>
      <p class="create-where">⌖ ${esc(item.place)}${distance ? ` · ${distance.toFixed(1)} km away` : ''}</p>
      <p class="drop-by">Started by ${esc(item.by)} · ${ago(item.created)}</p>
      <div class="create-actions">
        ${item.kind === 'audio' ? `<button type="button" data-act="join">${audioItem?.id === item.id ? 'You are in' : 'Join audio'}</button>` : ''}
        <button type="button" data-act="chat" class="${item.kind === 'audio' ? 'quiet' : ''}">${item.kind === 'room' ? 'Open chat room' : item.kind === 'event' ? 'Event chat' : 'Text chat'}</button>
        <button type="button" data-act="share" class="quiet" title="Copy a link to this spot">Share</button>
      </div>
      <small class="create-status" role="status"></small>`;
    card.querySelector<HTMLButtonElement>('.create-x')!.onclick = () => { closePopup(); markers.get(id)?.getElement().classList.remove('is-active'); };
    card.querySelector<HTMLButtonElement>('[data-act=chat]')!.onclick = () => { closePopup(); options.openChat(item.id, item.title, KINDS[item.kind].label); };
    card.querySelector<HTMLButtonElement>('[data-act=join]')?.addEventListener('click', () => { closePopup(); void joinAudio(item); });
    card.querySelector<HTMLButtonElement>('[data-act=share]')!.onclick = async () => {
      const link = `${location.origin}/?at=${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
      await navigator.clipboard?.writeText(`${item.title} · ${link}`).catch(() => undefined);
      card.querySelector('.create-status')!.textContent = 'Link copied';
    };
    show(at, card, 'create-popup');
    if (fresh) {
      if (item.kind === 'room') { closePopup(); options.openChat(item.id, item.title, KINDS.room.label); }
      if (item.kind === 'audio') { closePopup(); void joinAudio(item); }
    }
  }

  // ------------------------------------------------------------ audio panel
  async function joinAudio(item: Created) {
    if (audioItem?.id === item.id) { audioPanel.hidden = false; return; }
    audio?.leave();
    audioItem = item;
    audioPanel.hidden = false;
    document.body.classList.add('audio-on');
    renderAudio(undefined, 'Asking for your microphone…');
    const session = new AudioSession(item.id, options.user().name, (s, note) => {
      if (s !== audio) return;
      renderAudio(s, note);
      const self = items.get(item.id);
      if (self) { self.live = s.participants.size; paint(self); }
    });
    audio = session;
    try { await session.join(); }
    catch (error) { if (audio === session) { audio = undefined; renderAudio(undefined, (error as Error).message); } }
  }

  function leaveAudio() {
    audio?.leave();
    audio = undefined; audioItem = undefined;
    audioPanel.hidden = true;
    document.body.classList.remove('audio-on');
    scheduleFetch(0);
  }

  function renderAudio(session?: AudioSession, note?: string) {
    if (!audioItem) return;
    const people = session ? [...session.participants.values()] : [];
    audioPanel.innerHTML = `
      <header><span class="create-kicker"><i class="live-dot"></i>Live audio</span><button type="button" class="create-x" data-act="leave" aria-label="Leave session">×</button></header>
      <h3>${esc(audioItem.title)}</h3>
      <p class="create-where">⌖ ${esc(audioItem.place)}</p>
      <ul class="audio-people">${people.map(p => `
        <li class="${p.state}${p.me ? ' me' : ''}" data-peer="${p.peer}"><span class="audio-avatar" style="--level:${p.level.toFixed(2)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
          <span class="audio-name">${esc(p.name)}</span><small>${p.me ? (p.muted ? 'Muted' : 'Mic on') : p.state === 'connected' ? 'Connected' : p.state === 'failed' ? 'Could not connect' : 'Connecting…'}</small></li>`).join('')}
      </ul>
      ${note ? `<p class="audio-note">${esc(note)}</p>` : ''}
      <div class="create-actions">
        ${session ? `<button type="button" data-act="mute" class="${session.muted ? 'quiet' : ''}">${session.muted ? 'Unmute' : 'Mute'}</button>` : ''}
        <button type="button" data-act="chat" class="quiet">Text chat</button>
        <button type="button" data-act="leave" class="danger">Leave</button>
      </div>
      <small class="audio-fine">Peer-to-peer · up to 6 people · not recorded</small>`;
    audioPanel.querySelectorAll<HTMLButtonElement>('[data-act=leave]').forEach(b => { b.onclick = leaveAudio; });
    audioPanel.querySelector<HTMLButtonElement>('[data-act=mute]')?.addEventListener('click', () => audio?.toggleMute());
    audioPanel.querySelector<HTMLButtonElement>('[data-act=chat]')!.onclick = () => { if (audioItem) options.openChat(audioItem.id, audioItem.title, KINDS.audio.label); };
  }

  // ------------------------------------------------------------ syncing
  function publishNearby() {
    const place = options.place();
    if (!place) return;
    options.onNearby([...items.values()].filter(item => kmFrom(place, item) <= 30).sort((a, b) => kmFrom(place, a) - kmFrom(place, b)));
  }

  async function fetchViewport() {
    if (!document.body.classList.contains('on-map')) return;
    const seq = ++fetchSeq;
    const b = options.map().getBounds();
    const place = options.place();
    // Always include ~30 km around the area center, so the activity list stays complete.
    const pad = place ? { w: place.lng - 0.35, s: place.lat - 0.28, e: place.lng + 0.35, n: place.lat + 0.28 } : undefined;
    const box = [Math.max(-180, Math.min(b.getWest(), pad?.w ?? 180)), Math.max(-85, Math.min(b.getSouth(), pad?.s ?? 90)),
      Math.min(180, Math.max(b.getEast(), pad?.e ?? -180)), Math.min(85, Math.max(b.getNorth(), pad?.n ?? -90))];
    try {
      const response = await fetch('/api/places?bbox=' + box.map(v => v.toFixed(4)).join(','));
      const { items: list } = await response.json() as { items: Created[] };
      if (seq !== fetchSeq) return;
      const seen = new Set(list.map(i => i.id));
      for (const [id, marker] of markers) {
        const item = items.get(id)!;
        const inside = item.lat >= box[1] && item.lat <= box[3] && item.lng >= box[0] && item.lng <= box[2];
        if (inside && !seen.has(id) && audioItem?.id !== id) { marker.remove(); markers.delete(id); items.delete(id); }
      }
      list.forEach(item => {
        if (audioItem?.id === item.id && audio) item.live = audio.participants.size;
        add(item);
      });
      publishNearby();
    } catch { /* keep what is on the map */ }
  }
  function scheduleFetch(delay = 300) { clearTimeout(fetchTimer); fetchTimer = window.setTimeout(fetchViewport, delay); }
  map.on('moveend', () => scheduleFetch());
  window.setInterval(() => { if (!document.hidden) scheduleFetch(0); }, 20000);
  let lastPlace: Place | undefined;
  new MutationObserver(() => {
    const place = options.place();
    if (document.body.classList.contains('on-map') && place !== lastPlace) { lastPlace = place; closePopup(); scheduleFetch(0); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.body.classList.contains('creating')) stop();
    else if (popup) closePopup();
  });
  addEventListener('pagehide', () => audio?.leave());

  document.querySelector<HTMLButtonElement>('#create-mode')?.addEventListener('click', () => {
    if (document.body.classList.contains('creating')) stop(); else start();
  });

  return {
    start,
    refresh: () => scheduleFetch(0),
    has: (id: string) => items.has(id),
    open: (id: string) => open(id),
  };
}
