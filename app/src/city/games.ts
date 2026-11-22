import maplibregl from 'maplibre-gl';
import type { Place } from '../world/earth';
import { cityScope } from './scope';
import './games.css';

interface Game {
  id: string;
  title: string;
  venue: string;
  owner: string;
  mine: boolean;
  question: string;
  choices: string[];
  round: number;
  closes: number;
  locked: boolean;
  ended: boolean;
  result: number | null;
  pick: number | null;
  counts: number[];
  history: { question: string; answer: string; correct: number; total: number }[];
  /** Fixtures found by Claude: real local matches and events, with its own pick. */
  ai?: { fixture: string; kind: 'match' | 'event'; status: 'live' | 'upcoming'; start: number; pick: number; confidence: number; why: string; source: string; lat?: number; lng?: number };
}
type Screen = 'list' | 'game' | 'create' | 'next' | 'fixture';
const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isVoid = (game: Game) => game.ended && game.result === null;
const isLocked = (game: Game) => game.ended || game.locked || game.closes <= Date.now();
function timer(game: Game) {
  const seconds = Math.max(0, Math.ceil((game.closes - Date.now()) / 1000));
  if (seconds >= 86400) return Math.floor(seconds / 86400) + 'd ' + Math.floor(seconds % 86400 / 3600) + 'h';
  if (seconds >= 3600) return Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm';
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
function when(start: number) {
  const now = Date.now();
  if (start <= now) return 'Live now';
  const d = new Date(start), today = new Date();
  const day = d.toDateString() === today.toDateString() ? 'Today'
    : d.toDateString() === new Date(today.getTime() + 86400000).toDateString() ? 'Tomorrow'
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return day + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function phase(game: Game) {
  if (isVoid(game)) return 'Ended, no result';
  if (game.ended) return 'Full time';
  if (game.result !== null) return 'Result in';
  if (isLocked(game)) return 'Picks locked';
  return 'Picks open';
}

export function mountGames(getPlace: () => Place | undefined, getMap?: () => maplibregl.Map) {
  const dialog = document.createElement('dialog');
  dialog.className = 'city-games';
  dialog.setAttribute('aria-labelledby', 'games-heading');
  dialog.innerHTML = `<header class="games-header"><div><span class="games-location"></span>
    <h2 id="games-heading" tabindex="-1">Live predictions</h2></div>
    <button type="button" class="games-close" data-act="close" aria-label="Close predictions">×</button></header>
    <div class="games-content" tabindex="-1"></div><div class="games-status" id="games-status" role="status"></div>`;
  document.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>('.games-content')!;
  const status = dialog.querySelector<HTMLElement>('.games-status')!;
  let scope = '';
  let games: Game[] = [];
  let screen: Screen = 'list';
  let current = '';
  let loaded = false;
  let busy = false;
  let revision = 0;
  let interval = 0;
  let polling = false;
  let prefill: { title: string; venue: string } | undefined;
  let createId = '';
  let draftRound: number | undefined;
  let confirmVoid = false;
  let lastRender = '';
  let pollWarning = false;
  let discovering = false;
  const discovered = new Set<string>();
  let venueMarker: maplibregl.Marker | undefined;

  function statusMessage(message: string, syncError = false) {
    status.textContent = message;
    pollWarning = syncError;
  }
  function show(next: Screen, id = '') {
    screen = next;
    current = id;
    if (next === 'create') createId = crypto.randomUUID();
    confirmVoid = false;
    draftRound = next === 'next' ? games.find(g => g.id === id)?.round : undefined;
    render(true);
    if (next === 'create' || next === 'next') {
      content.querySelector<HTMLInputElement>(prefill?.title || next === 'next' ? '[name=question]' : '[name=title]')?.focus();
    } else focusHeading();
  }
  // After a rendered action, focus lands on a named heading rather than the unnamed scroll area.
  function focusHeading() {
    (content.querySelector<HTMLElement>(screen === 'game' ? '.games-host h4' : 'h3') ?? content.querySelector<HTMLElement>('.games-title') ?? dialog.querySelector<HTMLElement>('#games-heading'))?.focus({preventScroll:true});
  }
  /** Claude's fixtures, grouped: one row per match or event, with all of its questions. */
  function fixtureGroups() {
    const groups = new Map<string, Game[]>();
    for (const g of games) if (g.ai) groups.set(g.ai.fixture, [...(groups.get(g.ai.fixture) ?? []), g]);
    return [...groups.values()].sort((a, b) => a[0].ai!.start - b[0].ai!.start);
  }
  function aiSection() {
    const groups = fixtureGroups();
    const rows = groups.map(list => {
      const f = list[0], made = list.filter(g => g.pick !== null).length;
      const live = f.ai!.start <= Date.now();
      return `<button class="games-fixture games-ai-fixture" data-act="fixture" data-id="${esc(f.ai!.fixture)}">
        <span><strong>${esc(f.title)}</strong><small>${esc(f.venue)}</small><small class="games-when${live ? ' is-live' : ''}">${live ? '● ' : ''}${when(f.ai!.start)}</small></span>
        <span class="games-tag">${made ? made + '/' + list.length + ' picked' : list.length + ' predictions'}</span><span aria-hidden="true">›</span></button>`;
    }).join('');
    return `<h3 tabindex="-1">Happening near you</h3>
      ${rows || (discovering ? '<p class="games-empty games-finding">Claude is looking for matches and events near you…</p>' : '<p class="games-empty">No big matches or events found nearby this week.</p>')}`;
  }
  function overview() {
    const live = games.filter(g => !g.ended && !g.ai);
    const finished = games.filter(g => g.ended && !g.ai);
    const rows = (entries: Game[]) => entries.map(g => `<button class="games-fixture" data-act="view" data-id="${esc(g.id)}">
      <span><strong>${esc(g.title)}</strong><small>${esc(g.venue)} · Round ${g.round}</small></span>
      <span class="games-tag">${phase(g)}</span><span aria-hidden="true">›</span></button>`).join('');
    return `<div class="games-intro"><p>Pick what happens next in a match near you. Free to play.</p>
      <button class="games-primary" data-act="host" ${loaded && scope ? '' : 'disabled'}>Host a fixture</button></div>
      ${!scope ? '<p>Choose a city on the map to find its fixtures.</p>' : !loaded ? '<p>Loading fixtures…</p>' : `
      ${aiSection()}
      <h3>Hosted by people</h3>${live.length ? rows(live) : '<p class="games-empty">No live fixtures yet. At a match? Host its first question.</p>'}
      ${finished.length ? '<h3>Finished fixtures</h3>' + rows(finished) : ''}`}`;
  }
  const back = (label: string) => `<button class="games-back" data-act="back">← ${label}</button>`;
  function fixturesFor(target: { title: string; venue: string }) {
    return games.filter(g => same(g.title, target.title) && (!target.venue || same(g.venue, target.venue)));
  }
  function form(game?: Game) {
    const field = (name: string, label: string, maxlength: number, placeholder: string, value = '') =>
      `<label>${label}<input name="${name}" required maxlength="${maxlength}" placeholder="${placeholder}" value="${esc(value)}"></label>`;
    return `${back(game ? 'Fixture' : 'Fixtures')}<h3 tabindex="-1">${game ? 'Next question' : 'Host a fixture'}</h3>
      <p>${game ? esc(game.title) + ' · Round ' + (game.round + 1) : 'Start with a match happening now. Picks stay open for five minutes, or until you lock them.'}</p>
      ${!game && prefill && fixturesFor(prefill).length ? '<p>Earlier fixtures for this match have finished. Start a new one, or go back to see their results.</p>' : ''}
      <form class="games-form">${game ? '' : field('title','Fixture name',80,'e.g. Riverside vs Parkside',prefill?.title) +
        field('venue','Venue',100,'e.g. Central Park, Field 2',prefill?.venue)}
      ${field('question','Prediction question',120,'e.g. Who will score next?')}
      <div class="games-pair">${field('first option','First option',50,'e.g. Riverside')}${field('second option','Second option',50,'e.g. Parkside')}</div>
      <button type="submit" class="games-primary">${game ? 'Open next round' : 'Start fixture'}</button></form>`;
  }
  function detail(game: Game) {
    const locked = isLocked(game);
    const settled = game.result !== null;
    const total = game.counts.reduce((a,b) => a+b, 0);
    const choices = game.choices.map((name,i) => {
      const selected = game.pick === i, won = game.result === i;
      if (game.ended) return `<div class="games-choice"><span><strong>${esc(name)}</strong>${won ? '<small>Correct answer</small>' : ''}${selected ? '<small>Your pick</small>' : ''}</span>
        <span>${game.counts[i]} ${game.counts[i] === 1 ? 'pick' : 'picks'}</span></div>`;
      return `<button type="button" class="games-choice" data-act="pick" data-choice="${i}" aria-pressed="${selected}" ${locked ? 'disabled' : ''}>
        <span><strong>${esc(name)}</strong>${won ? '<small>Correct answer</small>' : ''}${selected ? '<small>Your pick</small>' : ''}</span>
        <span>${game.counts[i]} ${game.counts[i] === 1 ? 'pick' : 'picks'}</span></button>`;
    }).join('');
    const host = !game.mine || game.ended ? '' : confirmVoid ? `<div class="games-host games-confirm" role="group" aria-labelledby="void-heading">
      <h4 id="void-heading" tabindex="-1">End this fixture without a result?</h4>
      <p>${settled ? '' : 'Round ' + game.round + ' (' + esc(game.question) + ') will be marked void and will not count. '}Nobody can pick or ask another question. Earlier rounds stay in the history. You cannot undo this.</p>
      <button class="games-danger" data-act="void">End without result</button><button data-act="void-cancel">Keep playing</button></div>` :
      `<div class="games-host"><h4 tabindex="-1">Host controls</h4>${settled ?
      '<button class="games-primary" data-act="compose">Ask next question</button><button data-act="end">End fixture</button>' :
      (locked ? `<p>Which outcome happened?</p>${game.choices.map((choice,i) => `<button data-act="result" data-choice="${i}">Confirm ${esc(choice)}</button>`).join('')}` :
      '<button data-act="lock">Lock picks now</button>') + '<button data-act="void-ask">End without result</button>'}</div>`;
    const history = game.history.slice(0, settled ? -1 : undefined);
    return `${back('Fixtures')}<div class="games-meta"><span class="games-tag">${phase(game)}</span><span>Round ${game.round}</span></div>
      <h3 class="games-title" tabindex="-1">${esc(game.title)}</h3><p>${esc(game.venue)} · Hosted by ${game.mine ? 'you' : esc(game.owner)}</p>
      <section class="games-round"><div class="games-meta"><span>${total} ${total === 1 ? 'prediction' : 'predictions'}</span>
      ${!locked ? '<span>Closes in <b data-countdown>' + timer(game) + '</b></span>' : ''}</div>
      <h4>${esc(game.question)}</h4><div class="games-choices">${choices}</div>
      ${isVoid(game) ? `<p class="games-void" role="note"><strong>Round ${game.round} was void.</strong> The host ended this fixture without confirming an outcome, so it does not count.</p>` : ''}
      <p>${isVoid(game) ? 'No more picks or questions.' : settled ? 'Outcome: ' + esc(game.choices[game.result!]) + (game.pick === null ? '.' : game.pick === game.result ? '. You called it!' : '. Your pick was ' + esc(game.choices[game.pick]) + '.') :
        locked ? 'Picks are locked. Waiting for the host to confirm the outcome.' : game.pick === null ? 'Choose one option before picks close.' : 'Your pick is saved. You can change it until picks close.'}</p></section>${host}
      ${history.length ? `<h4>Previous rounds</h4><ol class="games-history">${history.map(r => `<li><strong>${esc(r.question)}</strong><small>${esc(r.answer)} · ${r.correct} of ${r.total} correct</small></li>`).join('')}</ol>` : ''}`;
  }
  /** One match or event: every question on one screen, so people can make several predictions. */
  function fixtureScreen(key: string) {
    const list = games.filter(g => g.ai?.fixture === key);
    if (!list.length) return back('Fixtures') + '<p>This fixture is no longer listed.</p>';
    const f = list[0], ai = f.ai!;
    const live = ai.start <= Date.now();
    const questions = list.map(g => {
      const locked = isLocked(g), total = g.counts.reduce((a, b) => a + b, 0);
      const choices = g.choices.map((name, i) => `<button type="button" class="games-choice" data-act="pick" data-id="${esc(g.id)}" data-choice="${i}" aria-pressed="${g.pick === i}" ${locked ? 'disabled' : ''}>
          <span><strong>${esc(name)}</strong>${g.ai!.pick === i ? '<small class="games-ai-pick">Claude\'s pick · ' + g.ai!.confidence + '%</small>' : ''}${g.pick === i ? '<small>Your pick</small>' : ''}</span>
          <span>${g.counts[i]} ${g.counts[i] === 1 ? 'pick' : 'picks'}</span></button>`).join('');
      return `<section class="games-round"><div class="games-meta"><span>${total} ${total === 1 ? 'prediction' : 'predictions'}</span>
          ${locked ? '<span>Picks locked</span>' : '<span>Closes in <b>' + timer(g) + '</b></span>'}</div>
        <h4>${esc(g.question)}</h4><div class="games-choices">${choices}</div>
        <p class="games-ai-why"><b>Claude:</b> ${esc(g.ai!.why)}</p></section>`;
    }).join('');
    return `${back('Fixtures')}<div class="games-meta"><span class="games-tag">${ai.kind === 'event' ? 'Event' : 'Match'}</span><span class="games-when${live ? ' is-live' : ''}">${live ? '● ' : ''}${when(ai.start)}</span></div>
      <h3 class="games-title" tabindex="-1">${esc(f.title)}</h3>
      <p>${esc(f.venue)} · <a href="${esc(ai.source)}" target="_blank" rel="noopener noreferrer">Source ↗</a></p>
      ${ai.lat !== undefined && getMap ? `<button type="button" class="games-primary games-go" data-act="go" data-id="${esc(key)}">Go to venue</button>` : ''}
      <p class="games-ai-note">Make a prediction on each question. You can change your picks until they close. Found and predicted by Claude from public listings, so check the source.</p>
      ${questions}`;
  }
  function goToVenue(key: string) {
    const f = games.find(g => g.ai?.fixture === key);
    const map = getMap?.();
    if (!f?.ai || f.ai.lat === undefined || f.ai.lng === undefined || !map) return;
    dialog.close();
    venueMarker?.remove();
    const el = document.createElement('div');
    el.className = 'games-venue-pin';
    el.innerHTML = `<i></i><span>${esc(f.title)}</span>`;
    venueMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([f.ai.lng, f.ai.lat]).addTo(map);
    map.flyTo({ center: [f.ai.lng, f.ai.lat], zoom: 16, duration: 2200, essential: true });
  }
  /** Ask the server to look for real fixtures near this city (cached for a few hours). */
  async function discover() {
    const place = getPlace();
    if (!place || !scope || discovered.has(scope)) return;
    discovered.add(scope);
    discovering = true;
    render(true);
    try {
      const label = [place.locality, place.city, place.region, place.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch('/api/city/fixtures?city=' + encodeURIComponent(scope), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: place.lat, lng: place.lng, label }) });
        if (response.status !== 202) break;
        await new Promise(r => setTimeout(r, 15000)); // someone else is searching this city; wait for it
      }
    } catch { /* the board still works without Claude's fixtures */ }
    discovering = false;
    await refresh();
    render(true);
  }
  function render(force = false) {
    const game = games.find(g => g.id === current);
    if (!force && (screen === 'create' || screen === 'next')) return;
    const key = JSON.stringify([screen, current, loaded, confirmVoid, discovering, screen === 'game' ? [game, game && phase(game)] : games.map(g => [g.id,g.title,g.venue,g.round,phase(g),g.pick,g.counts])]);
    if (!force && key === lastRender) return;
    lastRender = key;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && content.contains(active) ? [active.dataset.act,active.dataset.id,active.dataset.choice] : undefined;
    content.innerHTML = screen === 'create' ? form() : game && screen === 'next' ? form(game) : screen === 'fixture' ? fixtureScreen(current) : game && screen === 'game' ? detail(game) : overview();
    if (focusKey?.[0]) {
      const same = [...content.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].find(b =>
        b.dataset.act === focusKey[0] && b.dataset.id === focusKey[1] && b.dataset.choice === focusKey[2]);
      if (same) same.focus({preventScroll:true}); else focusHeading();
    }
  }
  type FocusKey = { act?: string; id?: string; choice?: string; name?: string };
  function snapshot(): FocusKey | undefined {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !content.contains(active)) return;
    const name = active.getAttribute('name') ?? undefined;
    if (!active.dataset.act && !name) return;
    return { act: active.dataset.act, id: active.dataset.id, choice: active.dataset.choice, name };
  }
  function restoreFocus(key?: FocusKey) {
    const target = key && [...content.querySelectorAll<HTMLElement>('button:not(:disabled), input')].find(el =>
      key.name ? el.getAttribute('name') === key.name : el.dataset.act === key.act && el.dataset.id === key.id && el.dataset.choice === key.choice);
    if (target) target.focus({preventScroll:true}); else focusHeading();
  }
  // The server reports field errors as plain text; tie them to the field they describe.
  function fieldFor(message: string) {
    if (/different options/i.test(message)) return 'second option';
    return /^Please enter (.+)\.$/.exec(message)?.[1];
  }
  function endpoint() { return '/api/city/games?city=' + encodeURIComponent(scope); }
  async function refresh() {
    if (!scope || busy || polling || !dialog.open) return;
    const version = revision;
    polling = true;
    try {
      const response = await fetch(endpoint());
      if (!response.ok) throw Error();
      const data: { entries: Game[] } = await response.json();
      if (version !== revision || !dialog.open) return;
      const previous = screen === 'game' ? games.find(game => game.id === current) : undefined;
      games = data.entries;
      const updated = previous && games.find(game => game.id === current);
      loaded = true;
      if (pollWarning) statusMessage('');
      if (previous && updated && (updated.round !== previous.round || updated.result !== previous.result || updated.ended !== previous.ended || updated.locked !== previous.locked)) {
        statusMessage(updated.result !== null ? 'Outcome: ' + updated.choices[updated.result] : phase(updated));
      }
      if (prefill && screen === 'list') {
        const match = fixturesFor(prefill).find(game => !game.ended);
        return show(match ? 'game' : 'create', match?.id);
      }
      render();
    } catch {
      if (version === revision && dialog.open) statusMessage('Could not refresh fixtures. Reconnecting…', true);
    } finally { if (version === revision) polling = false; }
  }
  async function submit(action: string, extra: Record<string, unknown> = {}) {
    if (busy) return;
    const game = games.find(g => g.id === current);
    if (action !== 'create' && !game) return;
    const focusKey = snapshot();
    let failure = '';
    busy = true;
    polling = false;
    const version = ++revision;
    statusMessage('Saving…');
    content.inert = true;
    try {
      const response = await fetch(endpoint(), {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:game?.id ?? createId,round:draftRound ?? game?.round,action,...extra})});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save. Try again.');
      if (version !== revision || !dialog.open) return;
      games = [data as Game,...games.filter(g => g.id !== data.id)];
      prefill = undefined;
      content.inert = false;
      if ((data as Game).ai) show('fixture', (data as Game).ai!.fixture); else show('game', data.id);
      if (action === 'create' || action === 'next') content.querySelector<HTMLElement>('.games-title')?.focus({preventScroll:true});
      else restoreFocus(focusKey);
      statusMessage(action === 'pick' ? 'Pick saved.' : action === 'result' ? 'Outcome confirmed.' : action === 'void' ? 'Fixture ended without a result.' : 'Fixture updated.');
    } catch (error) {
      if (version === revision && dialog.open) statusMessage(failure = (error as Error).message);
    } finally {
      if (version === revision) {
        busy = false;
        content.inert = false;
        if (failure) {
          const field = content.querySelector<HTMLInputElement>(`.games-form [name="${fieldFor(failure) ?? ''}"]`);
          if (field) {
            field.setAttribute('aria-invalid', 'true');
            field.setAttribute('aria-describedby', 'games-status');
            field.focus();
          } else restoreFocus(focusKey);
        }
        void refresh();
      }
    }
  }
  dialog.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-act]');
    if (!button) return;
    const {act,id,choice} = button.dataset;
    if (act === 'close') return dialog.close();
    if (busy) return;
    statusMessage('');
    switch (act) {
      case 'host': prefill = undefined; return show('create');
      case 'view': return show('game', id);
      case 'fixture': return show('fixture', id);
      case 'go': return goToVenue(id ?? '');
      case 'compose': return show('next', current);
      case 'back':
        prefill = undefined;
        if (screen === 'fixture') return show('list');
        return screen === 'next' ? show('game', current) : show('list');
      case 'void-ask': confirmVoid = true; render(true); return content.querySelector<HTMLElement>('#void-heading')?.focus();
      case 'void-cancel': confirmVoid = false; render(true); return content.querySelector<HTMLElement>('[data-act=void-ask]')?.focus();
      case 'pick': case 'result':
        if (screen === 'fixture' && id) current = id; // a question on the fixture screen
        return void submit(act, {choice:Number(choice)});
      case 'lock': case 'end': case 'void': return void submit(act);
    }
  });
  dialog.addEventListener('submit', e => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.target as HTMLFormElement));
    void submit(screen === 'next' ? 'next' : 'create', fields);
  });
  dialog.addEventListener('input', event => {
    const field = event.target as HTMLInputElement;
    if (field.getAttribute('aria-invalid') !== 'true') return;
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
    statusMessage('');
  });
  function cancelConfirm() {
    confirmVoid = false;
    render(true);
    content.querySelector<HTMLElement>('[data-act=void-ask]')?.focus();
  }
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (confirmVoid) {
      event.preventDefault();
      cancelConfirm();
    }
  });
  // Escape pressed while focus sits outside the dialog still fires cancel; keep it to the confirmation.
  dialog.addEventListener('cancel', event => {
    if (!confirmVoid) return;
    event.preventDefault();
    cancelConfirm();
  });
  dialog.addEventListener('close', () => {
    clearInterval(interval);
    ++revision;
    busy = false;
    polling = false;
    content.inert = false;
  });
  document.addEventListener('click', e => {
    const opener = (e.target as Element).closest<HTMLElement>('[data-city-games]');
    if (!opener || dialog.open) return;
    const place = getPlace();
    scope = place ? cityScope(place) : '';
    dialog.querySelector('.games-location')!.textContent = place?.city || place?.locality || 'Local sports';
    prefill = opener.dataset.gameTitle ? { title:opener.dataset.gameTitle,venue:opener.dataset.gameVenue || '' } : undefined;
    games = [];
    loaded = false;
    statusMessage('');
    dialog.showModal();
    show('list');
    void refresh();
    void discover();
    let ticks = 0;
    interval = window.setInterval(() => {
      if (document.hidden || busy) return;
      render();
      const game = games.find(g => g.id === current);
      const countdown = content.querySelector('[data-countdown]');
      if (game && countdown) countdown.textContent = timer(game);
      if (++ticks % 3 === 0) void refresh();
    }, 1000);
  });
}
