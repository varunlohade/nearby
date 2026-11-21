// Communities around the world, neighbours nearby, and "connect your agent".
//
// Server: server/communities.ts (communities, boards, requests, presence) and
// server/agents.ts (agent keys, MCP at /api/mcp, REST at /api/agent/*).

import maplibregl from 'maplibre-gl';
import './community.css';
import type { Place } from '../world/earth';

interface Agentish { name: string; agent?: { label: string; kind: string } }
interface Community {
  id: string; name: string; description: string; tags: string[]; emoji: string; color: string;
  lat: number; lng: number; place: string; by: Agentish; created: number; members: number; joined?: boolean; mine?: boolean;
}
interface Post { id: string; text: string; by: Agentish; created: number; mine?: boolean }
interface Req { id: string; community: string; title: string; details: string; wantsContact: boolean; by: Agentish; created: number; status: 'open' | 'done'; replies: number; mine?: boolean }
interface Reply { id: string; message: string; contact?: string; sharedContact?: boolean; by: Agentish; created: number; mine?: boolean }
interface Neighbour { id: string; name: string; km: number }
interface AgentInfo { keyId: string; label: string; kind: string; created: number; last: number | null; log: { at: number; tool: string; ok: boolean; note: string }[] }

interface Options {
  map: () => maplibregl.Map;
  place: () => Place | undefined;
  user: () => { userId: string; name: string };
  openChat: (roomId: string, title: string, kind: string) => void;
}

const EMOJIS = ['🏘️', '🌳', '🍲', '⚽', '🎨', '📚', '🐾', '🚲', '🧘', '🎶', '🛠️', '💼'];
const COLORS = ['#f5bd52', '#75c4ee', '#f495ae', '#b5a1f0', '#9dc48c', '#e2ae85'];
const AGENT_KINDS: Record<string, string> = { openclaw: 'OpenClaw', hermes: 'Hermes Agent', muse: 'Muse', instinct: 'Instinct', 'claude-code': 'Claude Code', custom: 'Your own agent' };

const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => new maplibregl.LngLat(a.lng, a.lat).distanceTo(new maplibregl.LngLat(b.lng, b.lat)) / 1000;
const author = (by: Agentish) => by.agent
  ? `<span class="cm-agent" title="Written by an AI agent for ${esc(by.name)}">🤖 ${esc(by.name)}'s agent · ${esc(by.agent.label)}</span>`
  : `<b>${esc(by.name)}</b>`;

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data as T;
}

export function mountCommunities(options: Options) {
  const app = document.querySelector('#app')!;
  const markers = new Map<string, maplibregl.Marker>();
  let communities: Community[] = [];
  let openId = '';
  let tab: 'board' | 'requests' | 'members' = 'board';

  // ------------------------------------------------------------ identity: keep the server's name in step with the chat name
  const syncName = () => { const name = options.user().name; if (name) void api('/api/me', { name }).catch(() => undefined); };
  syncName();
  document.addEventListener('submit', event => { if ((event.target as HTMLElement).id === 'name-form') setTimeout(syncName, 50); }, true);

  // ------------------------------------------------------------ Activities panel: communities + neighbours
  const section = document.createElement('section');
  section.className = 'cm-section';
  section.innerHTML = `
    <div class="cm-neighbours"><button type="button" class="cm-near-count"><i></i><span>Neighbours nearby</span></button>
      <label class="cm-toggle"><input type="checkbox" /><span>Show me</span></label></div>
    <header class="cm-head"><h3>Communities</h3><span class="cm-count">0</span><button type="button" class="cm-new">+ Start</button><button type="button" class="cm-agents-open">🤖 Agents</button></header>
    <div class="cm-list"></div>`;
  const head = document.querySelector('#activity-panel .nearby-head');
  head?.after(section);
  const list = section.querySelector<HTMLElement>('.cm-list')!;

  function renderList() {
    const place = options.place();
    const near = place ? communities.filter(c => kmBetween(place, c) <= 30).sort((a, b) => Number(!!b.joined) - Number(!!a.joined) || kmBetween(place, a) - kmBetween(place, b)) : communities;
    section.querySelector('.cm-count')!.textContent = String(near.length);
    list.innerHTML = near.length ? near.slice(0, 6).map(c => `
      <button type="button" class="cm-row" data-community="${c.id}" style="--cm:${c.color}">
        <span class="cm-emoji">${esc(c.emoji)}</span>
        <span class="cm-copy"><b>${esc(c.name)}</b><small>${c.members} member${c.members === 1 ? '' : 's'}${place ? ' · ' + kmBetween(place, c).toFixed(1) + ' km' : ''}${c.joined ? ' · joined' : ''}</small></span>
      </button>`).join('') + (near.length > 6 ? `<p class="cm-more">${near.length - 6} more on the map</p>` : '')
      : `<p class="cm-empty">No communities here yet. <button type="button" class="cm-new">Start the first one</button> — anyone nearby can join.</p>`;
    list.querySelectorAll<HTMLButtonElement>('[data-community]').forEach(b => { b.onclick = () => void openCommunity(b.dataset.community!); });
    section.querySelectorAll<HTMLButtonElement>('.cm-new').forEach(b => { b.onclick = () => startForm(); });
  }

  // ------------------------------------------------------------ map pins
  function pin(c: Community) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cm-pin';
    el.style.setProperty('--cm', c.color);
    el.setAttribute('aria-label', 'Community: ' + c.name);
    el.innerHTML = `<span class="cm-pin-face">${esc(c.emoji)}</span><span class="cm-pin-name">${esc(c.name)}</span>`;
    el.onclick = event => { event.stopPropagation(); void openCommunity(c.id); };
    return el;
  }
  function draw() {
    const seen = new Set(communities.map(c => c.id));
    for (const [cid, marker] of markers) if (!seen.has(cid)) { marker.remove(); markers.delete(cid); }
    for (const c of communities) {
      if (!markers.has(c.id)) markers.set(c.id, new maplibregl.Marker({ element: pin(c), anchor: 'bottom' }).setLngLat([c.lng, c.lat]).addTo(options.map()));
      markers.get(c.id)!.getElement().classList.toggle('is-joined', !!c.joined);
    }
  }

  let seq = 0;
  async function refresh() {
    if (!document.body.classList.contains('on-map')) return;
    const mine = ++seq;
    const b = options.map().getBounds(), place = options.place();
    const pad = place ? [place.lng - 0.35, place.lat - 0.28, place.lng + 0.35, place.lat + 0.28] : [180, 90, -180, -90];
    const box = [Math.max(-180, Math.min(b.getWest(), pad[0])), Math.max(-85, Math.min(b.getSouth(), pad[1])), Math.min(180, Math.max(b.getEast(), pad[2])), Math.min(85, Math.max(b.getNorth(), pad[3]))];
    try {
      const { communities: found } = await api<{ communities: Community[] }>('/api/communities?bbox=' + box.map(v => v.toFixed(4)).join(','));
      if (mine !== seq) return;
      communities = found;
      draw(); renderList();
    } catch { /* keep what is shown */ }
  }
  let timer = 0;
  const soon = (ms = 300) => { clearTimeout(timer); timer = window.setTimeout(() => void refresh(), ms); };
  options.map().on('moveend', () => soon());
  setInterval(() => { if (!document.hidden) soon(0); }, 30000);

  // ------------------------------------------------------------ start a community
  const sheet = document.createElement('aside');
  sheet.className = 'cm-panel';
  sheet.hidden = true;
  app.append(sheet);
  const closeSheet = () => { sheet.hidden = true; openId = ''; document.body.classList.remove('cm-open'); };

  function startForm(at?: { lat: number; lng: number; where?: string }) {
    const point = at ?? (() => { const c = options.map().getCenter().wrap(); return { lat: c.lat, lng: c.lng }; })();
    openId = '';
    sheet.hidden = false;
    document.body.classList.add('cm-open');
    const area = options.place()?.locality ?? 'this area';
    sheet.innerHTML = `
      <header class="cm-panel-head"><span class="cm-kicker">New community</span><button type="button" class="cm-x" aria-label="Close">×</button></header>
      <form class="cm-form">
        <p class="cm-lede">A place for neighbours to meet, ask for help and organise things. It is pinned ${at?.where ? 'near <b>' + esc(at.where) + '</b>' : 'at the map centre'} and anyone in the world can find it.</p>
        <label><span>Name</span><input name="name" required minlength="3" maxlength="50" value="${esc(area)} neighbours" /></label>
        <label><span>What is it about?</span><textarea name="description" maxlength="280" rows="3" placeholder="Help, tips, lost and found, weekend meetups…"></textarea></label>
        <label><span>Topics <small>(comma separated)</small></span><input name="tags" maxlength="100" placeholder="help, food, walks, parents" /></label>
        <div class="cm-pick"><span>Look</span><div class="cm-emojis">${EMOJIS.map((e, i) => `<label><input type="radio" name="emoji" value="${e}"${i === 0 ? ' checked' : ''} /><span>${e}</span></label>`).join('')}</div>
          <div class="cm-colors">${COLORS.map((c, i) => `<label style="--cm:${c}"><input type="radio" name="color" value="${c}"${i === 0 ? ' checked' : ''} /><span></span></label>`).join('')}</div></div>
        <div class="cm-actions"><button type="button" class="cm-cancel">Cancel</button><button type="submit">Create community</button></div>
        <small class="cm-status" role="status"></small>
      </form>`;
    sheet.querySelector<HTMLButtonElement>('.cm-x')!.onclick = closeSheet;
    sheet.querySelector<HTMLButtonElement>('.cm-cancel')!.onclick = closeSheet;
    const form = sheet.querySelector<HTMLFormElement>('form')!;
    form.onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(form);
      const status = form.querySelector('.cm-status')!;
      const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      button.disabled = true; status.textContent = 'Creating…';
      try {
        const { community } = await api<{ community: Community }>('/api/communities', {
          name: data.get('name'), description: data.get('description'), tags: data.get('tags'), emoji: data.get('emoji'), color: data.get('color'),
          lat: point.lat, lng: point.lng, place: at?.where,
        });
        communities = [community, ...communities.filter(c => c.id !== community.id)];
        draw(); renderList();
        void openCommunity(community.id);
      } catch (error) { status.textContent = (error as Error).message; button.disabled = false; }
    };
    requestAnimationFrame(() => form.querySelector<HTMLInputElement>('input[name=name]')?.select());
  }
  document.addEventListener('nearby:create-community', event => startForm((event as CustomEvent).detail));

  // ------------------------------------------------------------ community panel
  async function openCommunity(cid: string, keepTab = false) {
    openId = cid;
    if (!keepTab) tab = 'board';
    sheet.hidden = false;
    document.body.classList.add('cm-open');
    if (!sheet.querySelector(`[data-open="${cid}"]`)) sheet.innerHTML = '<p class="cm-loading">Opening…</p>';
    try {
      const data = await api<{ community: Community; joined: boolean; members: { name: string; me: boolean }[]; posts: Post[]; requests: Req[] }>('/api/communities/' + cid);
      if (openId !== cid) return;
      render(data);
      const c = data.community;
      options.map().easeTo({ center: [c.lng, c.lat], zoom: Math.max(options.map().getZoom(), 14), offset: innerWidth > 900 ? [-160, 0] : [0, -120], duration: 500 });
    } catch (error) { sheet.innerHTML = `<p class="cm-loading">${esc((error as Error).message)}</p>`; }
  }

  function render(data: { community: Community; joined: boolean; members: { name: string; me: boolean }[]; posts: Post[]; requests: Req[] }) {
    const c = data.community;
    const open = data.requests.filter(r => r.status === 'open').length;
    sheet.style.setProperty('--cm', c.color);
    sheet.innerHTML = `
      <header class="cm-panel-head" data-open="${c.id}">
        <span class="cm-kicker">Community · ${c.members} member${c.members === 1 ? '' : 's'}</span><button type="button" class="cm-x" aria-label="Close">×</button>
      </header>
      <div class="cm-hero"><span class="cm-emoji big">${esc(c.emoji)}</span><div><h2>${esc(c.name)}</h2><p class="cm-place">⌖ ${esc(c.place)}</p></div></div>
      ${c.description ? `<p class="cm-desc">${esc(c.description)}</p>` : ''}
      ${c.tags.length ? `<p class="cm-tags">${c.tags.map(t => `<span>#${esc(t)}</span>`).join('')}</p>` : ''}
      <div class="cm-actions top">
        <button type="button" data-act="${data.joined ? 'leave' : 'join'}" class="${data.joined ? 'quiet' : ''}">${data.joined ? '✓ Joined' : 'Join community'}</button>
        <button type="button" data-act="chat">Live chat</button>
        <button type="button" data-act="share" class="quiet">Share</button>
      </div>
      <nav class="cm-tabs">
        <button type="button" data-tab="board" class="${tab === 'board' ? 'on' : ''}">Board</button>
        <button type="button" data-tab="requests" class="${tab === 'requests' ? 'on' : ''}">Requests${open ? ` <em>${open}</em>` : ''}</button>
        <button type="button" data-tab="members" class="${tab === 'members' ? 'on' : ''}">Members</button>
      </nav>
      <div class="cm-body"></div>`;
    sheet.querySelector<HTMLButtonElement>('.cm-x')!.onclick = closeSheet;
    sheet.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab as typeof tab; render(data); }; });
    sheet.querySelector<HTMLButtonElement>('[data-act=join]')?.addEventListener('click', async () => { await api(`/api/communities/${c.id}/join`, {}); void openCommunity(c.id, true); soon(0); });
    sheet.querySelector<HTMLButtonElement>('[data-act=leave]')?.addEventListener('click', async () => {
      if (!confirm(`Leave ${c.name}?`)) return;
      await api(`/api/communities/${c.id}/leave`, {}); void openCommunity(c.id, true); soon(0);
    });
    sheet.querySelector<HTMLButtonElement>('[data-act=chat]')!.onclick = () => options.openChat(c.id, c.name, 'Community');
    sheet.querySelector<HTMLButtonElement>('[data-act=share]')!.onclick = async () => {
      await navigator.clipboard?.writeText(`${c.name} · ${location.origin}/?at=${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).catch(() => undefined);
      sheet.querySelector('[data-act=share]')!.textContent = 'Link copied';
    };
    const body = sheet.querySelector<HTMLElement>('.cm-body')!;
    if (tab === 'board') board(body, c, data);
    else if (tab === 'requests') requests(body, c, data);
    else body.innerHTML = `<ul class="cm-members">${data.members.map(m => `<li><span class="cm-avatar">${esc(m.name.slice(0, 1).toUpperCase())}</span>${esc(m.name)}${m.me ? ' <small>you</small>' : ''}</li>`).join('')}</ul>`;
  }

  function board(body: HTMLElement, c: Community, data: { joined: boolean; posts: Post[] }) {
    body.innerHTML = `
      ${data.joined ? `<form class="cm-compose"><textarea name="text" maxlength="600" rows="2" placeholder="Say hello, share a tip, ask a quick question…"></textarea><button type="submit">Post</button></form>`
        : '<p class="cm-hint">Join to post on the board.</p>'}
      <ol class="cm-posts">${[...data.posts].reverse().map(p => `<li class="${p.by.agent ? 'by-agent' : ''}"><p>${esc(p.text)}</p><small>${author(p.by)} · ${ago(p.created)}</small></li>`).join('') || '<li class="cm-empty">No posts yet. Start the conversation.</li>'}</ol>`;
    const form = body.querySelector<HTMLFormElement>('.cm-compose');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      const text = String(new FormData(form).get('text') ?? '').trim();
      if (!text) return;
      try { await api(`/api/communities/${c.id}/posts`, { text }); void openCommunity(c.id, true); }
      catch (error) { alert((error as Error).message); }
    };
  }

  function requests(body: HTMLElement, c: Community, data: { joined: boolean; requests: Req[] }) {
    body.innerHTML = `
      ${data.joined ? `<details class="cm-ask"><summary>+ Ask the community for something</summary>
        <form><label><span>What do you need?</span><input name="title" required minlength="4" maxlength="90" placeholder="Plumber tomorrow morning, a used bike, a babysitter…" /></label>
        <label><span>Details</span><textarea name="details" rows="2" maxlength="600" placeholder="When, where, budget…"></textarea></label>
        <label class="cm-check"><input type="checkbox" name="wantsContact" checked /> <span>Let people share a contact with me (only I will see it)</span></label>
        <button type="submit">Post request</button></form></details>` : '<p class="cm-hint">Join to ask for something.</p>'}
      <ol class="cm-requests">${data.requests.map(r => `
        <li class="cm-req ${r.status}${r.by.agent ? ' by-agent' : ''}" data-request="${r.id}">
          <h4>${esc(r.title)}${r.status === 'done' ? ' <em>done</em>' : ''}</h4>
          ${r.details ? `<p>${esc(r.details)}</p>` : ''}
          <small>${author(r.by)} · ${ago(r.created)} · ${r.replies} repl${r.replies === 1 ? 'y' : 'ies'}</small>
          <div class="cm-req-actions">${r.mine ? `<button type="button" data-act="replies">See replies</button>${r.status === 'open' ? '<button type="button" data-act="close" class="quiet">Mark done</button>' : ''}`
            : r.status === 'open' ? '<button type="button" data-act="help">I can help</button>' : ''}</div>
          <div class="cm-req-more"></div>
        </li>`).join('') || '<li class="cm-empty">No requests yet.</li>'}</ol>`;
    const ask = body.querySelector<HTMLFormElement>('.cm-ask form');
    if (ask) ask.onsubmit = async event => {
      event.preventDefault();
      const d = new FormData(ask);
      try { await api(`/api/communities/${c.id}/requests`, { title: d.get('title'), details: d.get('details'), wantsContact: d.get('wantsContact') === 'on' }); void openCommunity(c.id, true); }
      catch (error) { alert((error as Error).message); }
    };
    body.querySelectorAll<HTMLElement>('[data-request]').forEach(item => {
      const rid = item.dataset.request!, r = data.requests.find(x => x.id === rid)!;
      const more = item.querySelector<HTMLElement>('.cm-req-more')!;
      item.querySelector<HTMLButtonElement>('[data-act=help]')?.addEventListener('click', () => {
        more.innerHTML = `<form class="cm-help"><textarea name="message" rows="2" maxlength="400" placeholder="How you can help…"></textarea>
          ${r.wantsContact ? `<label><span>Share my contact <small>(optional · only ${esc(r.by.name)}${r.by.agent ? ' and their agent' : ''} will see it)</small></span><input name="contact" maxlength="80" placeholder="Phone, email or handle" /></label>` : ''}
          <button type="submit">Send</button></form>`;
        const form = more.querySelector<HTMLFormElement>('form')!;
        form.onsubmit = async event => {
          event.preventDefault();
          const d = new FormData(form);
          try {
            await api(`/api/communities/${c.id}/requests/${rid}/replies`, { message: d.get('message'), contact: d.get('contact') ?? '' });
            more.innerHTML = `<p class="cm-sent">Sent to ${esc(r.by.name)}.${d.get('contact') ? ' Your contact is visible only to them.' : ''}</p>`;
          } catch (error) { alert((error as Error).message); }
        };
        form.querySelector('textarea')?.focus();
      });
      item.querySelector<HTMLButtonElement>('[data-act=replies]')?.addEventListener('click', async () => {
        const found = await api<{ replies: Reply[] }>(`/api/communities/${c.id}/requests/${rid}`);
        more.innerHTML = `<ul class="cm-replies">${found.replies.map(y => `<li><p>${esc(y.message)}</p><small>${author(y.by)} · ${ago(y.created)}</small>
          ${y.contact ? `<p class="cm-contact">📇 ${esc(y.contact)}</p>` : ''}</li>`).join('') || '<li class="cm-empty">No replies yet.</li>'}</ul>`;
      });
      item.querySelector<HTMLButtonElement>('[data-act=close]')?.addEventListener('click', async () => { await api(`/api/communities/${c.id}/requests/${rid}/close`, {}); void openCommunity(c.id, true); });
    });
  }

  // ------------------------------------------------------------ neighbours nearby (opt-in)
  const toggle = section.querySelector<HTMLInputElement>('.cm-toggle input')!;
  const nearButton = section.querySelector<HTMLButtonElement>('.cm-near-count')!;
  let neighbours: Neighbour[] = [];
  toggle.checked = localStorage.getItem('nearby.presence') === 'on';
  async function beat() {
    const place = options.place();
    if (!place || !document.body.classList.contains('on-map')) return;
    if (toggle.checked) await api('/api/presence', { lat: place.lat, lng: place.lng }).catch(() => undefined);
    try {
      const found = await api<{ count: number; people: Neighbour[] }>(`/api/presence?lat=${place.lat.toFixed(4)}&lng=${place.lng.toFixed(4)}`);
      neighbours = found.people;
      nearButton.querySelector('span')!.textContent = found.count ? `${found.count} neighbour${found.count === 1 ? '' : 's'} nearby` : toggle.checked ? 'You are visible · nobody else yet' : 'No neighbours visible yet';
      nearButton.classList.toggle('has', found.count > 0);
    } catch { /* ignore */ }
  }
  toggle.onchange = async () => {
    localStorage.setItem('nearby.presence', toggle.checked ? 'on' : 'off');
    if (!toggle.checked) await api('/api/presence', { on: false }).catch(() => undefined);
    void beat();
  };
  setInterval(() => { if (!document.hidden) void beat(); }, 45000);
  nearButton.onclick = () => {
    sheet.hidden = false; openId = '';
    document.body.classList.add('cm-open');
    sheet.style.removeProperty('--cm');
    sheet.innerHTML = `
      <header class="cm-panel-head"><span class="cm-kicker">Neighbours nearby</span><button type="button" class="cm-x" aria-label="Close">×</button></header>
      <p class="cm-lede">People within about 5 km who chose to be visible. Positions are rounded to about 500 m and never shown exactly.
        ${toggle.checked ? 'You are visible as <b>' + esc(options.user().name) + '</b>.' : 'Turn on <b>Show me</b> to appear here too.'}</p>
      <ul class="cm-members">${neighbours.map(n => `<li><span class="cm-avatar">${esc(n.name.slice(0, 1).toUpperCase())}</span>${esc(n.name)} <small>~${n.km} km</small>
        <button type="button" data-hi="${esc(n.name)}">Say hi</button></li>`).join('') || '<li class="cm-empty">Nobody visible right now. Check back later, or start a community.</li>'}</ul>`;
    sheet.querySelector<HTMLButtonElement>('.cm-x')!.onclick = closeSheet;
    sheet.querySelectorAll<HTMLButtonElement>('[data-hi]').forEach(b => {
      b.onclick = () => {
        closeSheet();
        document.querySelector<HTMLButtonElement>('#mobile-chat')?.click();
        setTimeout(() => {
          const box = document.querySelector<HTMLInputElement>('#message-input');
          if (box) { box.value = `@${b.dataset.hi} hi 👋 I'm nearby too!`; box.focus(); }
        }, 350);
      };
    });
  };

  // ------------------------------------------------------------ agents
  const dialog = document.createElement('dialog');
  dialog.className = 'location-dialog cm-agents';
  document.body.append(dialog);
  const mcpUrl = () => location.origin + '/api/mcp';
  function setup(kind: string, key: string) {
    const url = mcpUrl(), k = key || 'nbk_YOUR_KEY';
    const json = JSON.stringify({ mcpServers: { nearby: { type: 'http', url, headers: { Authorization: 'Bearer ' + k } } } }, null, 2);
    const curl = `curl -X POST ${location.origin}/api/agent/find_communities \\\n  -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" \\\n  -d '{"lat":17.466,"lng":78.357,"query":"help"}'`;
    switch (kind) {
      case 'hermes': return { how: 'Add this to your Hermes config (~/.hermes/config.yaml), then run /reload-mcp in Hermes.', code: `mcp_servers:\n  nearby:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${k}"` };
      case 'claude-code': return { how: 'Run this in a terminal:', code: `claude mcp add --transport http nearby ${url} \\\n  --header "Authorization: Bearer ${k}"` };
      case 'openclaw': return { how: 'OpenClaw can use remote MCP servers. Add nearby as an HTTP MCP server with this URL and header (or paste this JSON where your OpenClaw setup lists MCP servers):', code: json };
      case 'muse': return { how: 'If your Muse setup supports remote MCP servers, add this one. Otherwise use the HTTP API below.', code: json };
      case 'instinct': return { how: 'Instinct does not offer a public way to add tools or MCP servers yet, as far as we know, so it cannot connect directly. Keep this key for when it does, or use it from any tool that can make HTTP calls:', code: curl };
      default: return { how: 'Any MCP client: use this URL and header. No MCP? Call the same tools over HTTP (GET /api/agent lists them):', code: json + '\n\n' + curl };
    }
  }
  async function showAgents(fresh?: { key: string; kind: string; label: string }) {
    let data: { owner: string; agents: AgentInfo[] };
    try { data = await api('/api/agents'); } catch (error) { dialog.innerHTML = `<div class="dialog-card"><p>${esc((error as Error).message)}</p></div>`; return; }
    const guide = fresh ? setup(fresh.kind, fresh.key) : undefined;
    dialog.innerHTML = `
      <div class="dialog-card cm-agents-card">
        <button class="round-button ghost dialog-close cm-x" type="button" aria-label="Close">×</button>
        <span class="mono kicker">Connect your agent</span>
        <h2>Let your agent ask for you</h2>
        <p>Your agent can find communities, post requests ("need a plumber tomorrow"), read replies and collect contacts that neighbours choose to share with you. Its posts are labelled as <b>${esc(data.owner)}'s agent</b>, checked for spam and safety, and limited to 20 messages an hour and 5 requests a day.</p>
        ${fresh && guide ? `<div class="cm-fresh"><b>Your key for ${esc(fresh.label)}</b> — copy it now, it is shown only once.
          <div class="cm-key"><code>${esc(fresh.key)}</code><button type="button" data-copy="${esc(fresh.key)}">Copy</button></div>
          <p>${esc(guide.how)}</p><pre>${esc(guide.code)}</pre><button type="button" data-copy="${esc(guide.code)}">Copy setup</button></div>` : ''}
        <form class="cm-connect"><div class="cm-kinds">${Object.entries(AGENT_KINDS).map(([k, l], i) => `<label><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''} /><span>${l}</span></label>`).join('')}</div>
          <label><span>Name it</span><input name="label" maxlength="30" placeholder="My OpenClaw" /></label>
          <button type="submit">Create key</button></form>
        <h3>Your agents</h3>
        <ul class="cm-agent-list">${data.agents.map(a => `<li><div><b>${esc(a.label)}</b> <small>${esc(AGENT_KINDS[a.kind] ?? a.kind)} · created ${ago(a.created)}${a.last ? ' · active ' + ago(a.last) : ''}</small></div>
          <button type="button" data-revoke="${a.keyId}" class="quiet">Revoke</button>
          <details><summary>Activity (${a.log.length})</summary><ol>${a.log.map(l => `<li class="${l.ok ? '' : 'fail'}">${new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${esc(l.note)}</li>`).join('')}</ol></details></li>`).join('') || '<li class="cm-empty">No agents connected yet.</li>'}</ul>
        <p class="cm-fine">MCP endpoint: <code>${esc(mcpUrl())}</code> · Keys are stored hashed. Revoke a key to cut its access at once.</p>
      </div>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('.cm-x')!.onclick = () => dialog.close();
    dialog.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => { b.onclick = async () => { await navigator.clipboard?.writeText(b.dataset.copy!).catch(() => undefined); b.textContent = 'Copied'; }; });
    dialog.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach(b => {
      b.onclick = async () => { if (!confirm('Revoke this key? The agent loses access right away.')) return; await api('/api/agents/' + b.dataset.revoke, undefined, 'DELETE'); void showAgents(); };
    });
    const form = dialog.querySelector<HTMLFormElement>('.cm-connect')!;
    form.onsubmit = async event => {
      event.preventDefault();
      const d = new FormData(form);
      try {
        const created = await api<{ key: string; agent: { kind: string; label: string } }>('/api/agents', { kind: d.get('kind'), label: d.get('label') });
        void showAgents({ key: created.key, kind: created.agent.kind, label: created.agent.label });
      } catch (error) { alert((error as Error).message); }
    };
  }
  section.querySelector<HTMLButtonElement>('.cm-agents-open')!.onclick = () => void showAgents();
  const topButton = document.createElement('button');
  topButton.type = 'button';
  topButton.className = 'round-button cm-agents-top';
  topButton.title = 'Connect your agent';
  topButton.setAttribute('aria-label', 'Connect your agent');
  topButton.textContent = '🤖';
  topButton.onclick = () => void showAgents();
  document.querySelector('.top-actions')?.prepend(topButton);

  // ------------------------------------------------------------ lifecycle
  let lastPlace: Place | undefined;
  new MutationObserver(() => {
    const place = options.place();
    if (document.body.classList.contains('on-map') && place !== lastPlace) { lastPlace = place; closeSheet(); soon(0); void beat(); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('keydown', event => { if (event.key === 'Escape' && !sheet.hidden && !dialog.open) closeSheet(); });

  return { refresh: () => soon(0), open: (cid: string) => void openCommunity(cid), start: startForm };
}
