import './styles.css';
import { CITY } from './config';
import { areaAt, loadAreas, ringAround, saveBuiltArea, slug, snapToArea } from './areas';
import { createChat, roomIdFor, type ChatMessage, type ChatService } from './chat';
import type { MapView } from './map/types';
import type { Area, Happening, LatLng } from './types';
import { loadUser, saveUser, guestId, type User } from './user';
import { ICON, KIND, LOGO, av, esc, stack } from './ui/icons';

const MOBILE = innerWidth < 600;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };

let areas: Area[] = loadAreas(CITY);
let user: User | null = loadUser();
const byId = (id: string) => areas.find((a) => a.id === id);

// ---------- shell ----------
document.body.append(
  h(`<div class="side">
      <div class="card brand"><div class="wordmark">${LOGO}nearby</div><span class="city">${CITY.name}</span><button class="me-btn" data-act="signin" aria-label="Sign in"></button></div>
      <div class="card feed"><div class="feed-head"><h2>What's happening</h2><small class="num">live</small></div><div class="rows"></div></div>
    </div>`),
  h(`<div class="mtop"><div class="wordmark">${LOGO}nearby</div><button class="me-btn" data-act="signin" aria-label="Sign in"></button></div>`),
  h(`<div class="card drawer"><div class="grab"></div><div class="feed-head"><h2>What's happening</h2><small>live</small></div><div class="rows"></div></div>`),
  h(`<div class="badges"><span class="badge" id="chat-badge"></span></div>`),
  h(`<div class="hint">Tap an empty spot to build your neighbourhood</div>`),
);

function renderMe() {
  document.querySelectorAll<HTMLButtonElement>('.me-btn').forEach((b) => {
    b.textContent = user ? user.name.slice(0, 2).toUpperCase() : 'Sign in';
    b.classList.toggle('out', !user);
  });
}
renderMe();
document.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'signin') openSignIn();
});

// ---------- feed ----------
function pushFeed(hp: Happening) {
  const area = byId(hp.areaId);
  const k = KIND[hp.kind];
  document.querySelectorAll<HTMLElement>('.rows').forEach((box) => {
    const max = box.closest('.drawer') ? 3 : 6;
    const first = [...box.children].map((n) => n.getBoundingClientRect().top);
    const row = h(`<div class="row fresh"><div class="ic" style="background:${k.color}">${k.icon}</div>
      <div class="tx"><p>${esc(hp.title)}</p><div class="meta"><span>${esc(area?.name ?? hp.place)}</span><time>${esc(hp.when)}</time></div></div></div>`);
    row.addEventListener('click', () => openHappening(hp));
    [...box.children].find((n) => n.querySelector('p')?.textContent === hp.title)?.remove();
    box.prepend(row);
    while (box.children.length > max) box.lastElementChild!.remove();
    [...box.children].slice(1).forEach((n, i) => {
      const d = first[i] - n.getBoundingClientRect().top;
      if (d) n.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.77,0,0.175,1)' });
    });
  });
}

// ---------- floating card (peek / build / area) ----------
let card: HTMLElement | null = null;
let cardAt: LatLng | null = null;
function closeCard() { card?.remove(); card = null; cardAt = null; }
function showCard(html: string, at: LatLng) {
  closeCard();
  card = h(`<div class="card peek show"><div class="nub"></div>${html}</div>`);
  document.body.append(card);
  card.querySelector('.x')?.addEventListener('click', closeCard);
  cardAt = at;
  placeCard();
  return card;
}
function placeCard() {
  if (!card || !cardAt) return;
  if (MOBILE) { card.classList.add('docked'); return; }
  const p = map.project(cardAt);
  const right = chatOpen ? innerWidth - 400 : innerWidth;
  const w = card.offsetWidth, hh = card.offsetHeight;
  let x = p.x + 250;
  const flip = x + w > right - 16;
  if (flip) x = p.x - 30 - w;
  const top = Math.max(16, Math.min(innerHeight - hh - 16, p.y - hh / 2));
  card.style.left = `${Math.max(16, x)}px`;
  card.style.top = `${top}px`;
  card.classList.toggle('flip', flip);
  (card.querySelector('.nub') as HTMLElement).style.top = `${Math.max(14, Math.min(hh - 26, p.y - top - 6))}px`;
}

function openHappening(hp: Happening) {
  const area = byId(hp.areaId);
  const k = KIND[hp.kind];
  const c = showCard(`
    <header><div><span class="tag" style="background:${k.color}">${k.icon}${k.label}</span><h3>${esc(hp.title)}</h3></div><button class="x" aria-label="Close">${ICON.x}</button></header>
    <div class="facts">
      <div>${ICON.pin}<span>${esc(hp.place)}${area ? `, ${esc(area.name)}` : ''}</span></div>
      <div>${ICON.clock}<span>${esc(hp.when)}</span></div>
    </div>
    <div class="blk people"><div><div class="lab">People here</div><b class="num">${hp.people}</b></div>${stack(Math.min(5, hp.people), hp.title.length)}</div>
    <button class="btn primary" data-join="${hp.areaId}">${ICON.chat}Join ${esc(area?.name ?? '')} chat</button>`, hp.at);
  c.querySelector<HTMLButtonElement>('[data-join]')!.onclick = () => { closeCard(); openChat(hp.areaId); };
  map.flyTo(hp.at, false);
}

function openArea(area: Area) {
  const mine = user?.areaId === area.id;
  const c = showCard(`
    <header><div><h3>${esc(area.name)}</h3><div class="sub num">${ICON.people}${area.hereNow} people here now</div></div><button class="x" aria-label="Close">${ICON.x}</button></header>
    ${area.founder ? `<div class="blk"><div class="lab">Founder</div><b>${esc(area.founder)}</b></div>` : ''}
    <div class="blk"><div class="lab">${mine ? 'This is your area' : 'Visiting'}</div><span class="muted">${mine ? 'You can post in this room.' : 'You can read this room. Only people who live here can post.'}</span></div>
    <button class="btn primary">${ICON.chat}Open ${esc(area.name)} chat</button>`, area.center);
  c.querySelector<HTMLButtonElement>('.btn')!.onclick = () => { closeCard(); openChat(area.id); };
}

function openBuild(at: LatLng) {
  if (!user) { openSignIn('Sign in first. Founders need a name.'); return; }
  const c = showCard(`
    <header><div><h3>Build your neighbourhood</h3><div class="sub">Nobody has started one here yet.</div></div><button class="x" aria-label="Close">${ICON.x}</button></header>
    <label class="field"><span>Name it</span><input class="input" maxlength="32" placeholder="e.g. Bellandur Lakeside" /></label>
    <div class="founder">${av(user.name)}<p>You'll be the founder<br><span>It becomes your area. Host events, invite people.</span></p></div>
    <p class="note">${ICON.lock}Others only see the area name. Your exact spot never leaves your device.</p>
    <button class="btn primary" disabled>Build it</button>`, at);
  const input = c.querySelector<HTMLInputElement>('input')!;
  const btn = c.querySelector<HTMLButtonElement>('.btn')!;
  input.oninput = () => { btn.disabled = input.value.trim().length < 2; };
  input.focus();
  btn.onclick = async () => {
    const name = input.value.trim();
    const id = `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const area: Area = { id, name, center: at, radiusKm: 0.8, ring: ringAround(at, 0.8, Math.random() * 3), hereNow: 1, founder: user!.name };
    btn.disabled = true; btn.textContent = 'Building...';
    try { await chat.ensureRoom(roomIdFor(CITY, id)); } catch (e) { btn.textContent = `Could not create room: ${(e as Error).message}`; return; }
    saveBuiltArea(CITY, area);
    areas.push(area);
    const prev = user!.areaId;
    user = saveUser(user!.name, id, user);
    map.setArea(area, true);
    const old = byId(prev); if (old) map.setArea(old, false);
    closeCard();
    openChat(id);
  };
}

// ---------- sign-in ----------
function openSignIn(reason?: string) {
  $('.modal')?.remove();
  const opts = areas.map((a) => `<option value="${a.id}" ${user?.areaId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const m = h(`<div class="modal"><div class="card sheet">
    <header><div><h3>${user ? 'Your profile' : 'Join nearby'}</h3><div class="sub">${esc(reason ?? 'No password. Just a name and your area.')}</div></div><button class="x" aria-label="Close">${ICON.x}</button></header>
    <label class="field"><span>Display name</span><input class="input" id="si-name" maxlength="40" value="${esc(user?.name ?? '')}" placeholder="e.g. Varun" /></label>
    <label class="field"><span>Your area</span><div class="row2"><select class="input" id="si-area"><option value="">Choose an area</option>${opts}</select>
      <button class="btn ghost" id="si-locate" type="button">${ICON.locate}Find me</button></div></label>
    <p class="note" id="si-note">${ICON.lock}Location is turned into an area name on this device. Only the area name is shared.</p>
    <button class="btn primary" id="si-go">${user ? 'Save' : 'Sign in'}</button></div></div>`);
  document.body.append(m);
  const name = m.querySelector<HTMLInputElement>('#si-name')!, sel = m.querySelector<HTMLSelectElement>('#si-area')!, note = m.querySelector<HTMLElement>('#si-note')!;
  m.querySelector('.x')!.addEventListener('click', () => m.remove());
  m.querySelector<HTMLButtonElement>('#si-locate')!.onclick = () => {
    if (!navigator.geolocation) { note.textContent = 'This browser has no location. Pick your area.'; return; }
    note.textContent = 'Finding your area...';
    navigator.geolocation.getCurrentPosition((pos) => {
      // The coordinates stay in this callback. Only the area id survives.
      const hit = snapToArea({ lat: pos.coords.latitude, lng: pos.coords.longitude }, areas);
      if (hit) { sel.value = hit.id; note.textContent = `You're in ${hit.name}. Only "${hit.name}" is shared.`; }
      else note.textContent = 'You are not near any area yet. Pick one, or build one on the map.';
    }, () => { note.textContent = 'Location is off. Pick your area.'; }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
  };
  m.querySelector<HTMLButtonElement>('#si-go')!.onclick = async () => {
    if (name.value.trim().length < 2) { name.focus(); return; }
    if (!sel.value) { note.textContent = 'Pick your area first.'; return; }
    const prev = user?.areaId;
    user = saveUser(name.value, sel.value, user);
    renderMe();
    [prev, user.areaId].forEach((id) => { const a = id && byId(id); if (a) map.setArea(a, a.id === user!.areaId); });
    m.remove();
    if (chatRoom) openChat(chatArea!);
  };
  name.focus();
}

// ---------- chat dock ----------
let chat: ChatService;
let chatOpen = false, chatRoom: string | null = null, chatArea: string | null = null;
let connectedAs: string | null = null;

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function msgEl(m: ChatMessage) {
  const mine = m.userId === (user?.userId ?? connectedAs);
  return h(mine
    ? `<div class="m mine"><time>${fmt(m.at)}</time><div class="b"><p>${esc(m.text)}</p></div></div>`
    : `<div class="m">${av(m.name)}<div class="b"><div class="n">${esc(m.name)}</div><p>${esc(m.text)}</p></div><time>${fmt(m.at)}</time></div>`);
}

async function openChat(areaId: string) {
  const area = byId(areaId); if (!area) return;
  $('.dock')?.remove();
  chatOpen = true; chatArea = areaId; chatRoom = roomIdFor(CITY, areaId);
  document.body.classList.add('chat-open');
  const canPost = !!user && user.areaId === areaId;
  const mineArea = user && byId(user.areaId);
  const d = h(`<aside class="dock"><header><div class="shape">${ICON.area(20)}</div><div><h3>${esc(area.name)}</h3><div class="sub num">${area.hereNow} here now · <span class="mode ${chat.mode}">${chat.label}</span></div></div><div class="sp"></div><button class="x" aria-label="Close chat">${ICON.x}</button></header>
    <div class="msgs"><div class="day">Today</div></div>
    ${canPost
      ? `<form class="composer"><input class="input" maxlength="500" placeholder="Message ${esc(area.name)}" /><button class="send" aria-label="Send">${ICON.send}</button></form>`
      : `<div class="locked">${ICON.lock}<span>${user ? `You can only post in your own area${mineArea ? ` (${esc(mineArea.name)})` : ''}.` : 'Sign in to post.'}</span>${user ? '' : '<button class="btn primary sm" data-act="signin">Sign in</button>'}</div>`}
  </aside>`);
  document.body.append(d);
  placeCard();
  const box = d.querySelector<HTMLElement>('.msgs')!;
  const add = (m: ChatMessage) => { if (!box.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) { const e = msgEl(m); e.dataset.id = m.id; box.append(e); box.scrollTop = box.scrollHeight; } };
  d.querySelector('.x')!.addEventListener('click', () => { d.remove(); chatOpen = false; chatRoom = null; document.body.classList.remove('chat-open'); void chat.leave(); });
  const room = chatRoom;
  try {
    const who = user ?? { userId: guestId(), name: 'Guest' };
    await chat.connect(who); connectedAs = who.userId;
    const backlog = await chat.join(room, (m) => { if (chatRoom === room) add(m); });
    backlog.forEach(add);
  } catch (e) {
    box.append(h(`<div class="err">Chat is not reachable: ${esc((e as Error).message)}</div>`));
  }
  const form = d.querySelector<HTMLFormElement>('.composer');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input')!; const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { add(await chat.send(room, text)); } catch (err) { box.append(h(`<div class="err">Not sent: ${esc((err as Error).message)}</div>`)); }
  });
}

// ---------- live happenings ----------
const live: { hp: Happening; remove: () => void }[] = [];
let seq = 0;
// Two pop-ups clash when their screen boxes would overlap .
// A spot is no good when it is off screen, under a panel, or too close to a live one.
function clashes(at: LatLng) {
  const p = map.project(at);
  const left = MOBILE ? 20 : 380, bottom = innerHeight - (MOBILE ? 240 : 40);
  if (p.x < left || p.x > innerWidth - (MOBILE ? 180 : 240) || p.y < 110 || p.y > bottom) return true;
  return live.some((l) => { const q = map.project(l.hp.at); return Math.abs(p.x - q.x) < (MOBILE ? 150 : 200) && Math.abs(p.y - q.y) < 56; });
}
let cursor = 0;
function popNext() {
  const n = CITY.happenings.length;
  let pick = cursor % n;
  for (let i = 0; i < n; i++) {
    const s = CITY.happenings[(cursor + i) % n];
    if (!live.some((l) => l.hp.title === s.title) && !clashes(s.at)) { pick = (cursor + i) % n; break; }
  }
  cursor = pick + 1;
  const hp: Happening = { ...CITY.happenings[pick], id: `h${seq++}` };
  const k = KIND[hp.kind];
  const html = hp.kind === 'joined'
    ? `<div class="chip joined">${stack(3, seq)}<b>${esc(hp.title)}</b></div>`
    : `<div class="chip"><span class="dot" style="background:${k.color}">${k.icon}</span><span class="t"><b>${esc(hp.title)}</b><small>${esc(hp.when)}</small></span></div>`;
  const old = live.findIndex((l) => l.hp.title === hp.title);
  if (old >= 0) live.splice(old, 1)[0].remove();
  live.push({ hp, remove: map.addHappening(hp, html, () => openHappening(hp)) });
  while (live.length > (MOBILE ? 5 : 8)) live.shift()!.remove();
  pushFeed(hp);
}
function tick() {
  popNext();
  setTimeout(tick, 1000 + Math.random() * 2000);
}

// ---------- boot ----------
let map: MapView;
async function boot() {
  chat = await createChat(CITY);
  $('#chat-badge').textContent = chat.mode === 'demo' ? 'demo chat' : 'chat: live on Nexconn';
  const el = $('#map');
  const { createMap } = await import('./map/map');
  map = await createMap(el, CITY, MOBILE);
  areas.forEach((a) => map.setArea(a, a.id === user?.areaId));
  map.onMove(placeCard);
  map.onMapClick((at) => {
    const a = areaAt(at, areas);
    if (a) openArea(a); else openBuild(at);
  });
  // Start with a handful on screen, then one every 1-3 s.
  for (let i = 0; i < 6; i++) setTimeout(popNext, 900 + i * 220);
  setTimeout(tick, 900 + 6 * 220 + 1200);
}
void boot();
