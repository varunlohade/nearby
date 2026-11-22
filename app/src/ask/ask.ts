// "Ask about my neighbourhood": an ask bar on the street map. POST /api/ask
// (server/ask.ts) streams events while Claude works: pins, routes, camera moves,
// opening an event or the chat, or flying to another area. Each event is applied
// to the map as it arrives, and a short mission log shows what is happening.

import maplibregl from 'maplibre-gl';
import './ask.css';
import type { Activity, Place } from '../world/earth';

interface MapPlace { name: string; lat: number; lng: number; kind: string; distanceM: number; detail?: string; address?: string }
interface Spot { label: string; lat: number; lng: number }
interface PlaceReviews { pin: number; name: string; sentiment: 'positive' | 'mixed' | 'negative' | 'unknown'; summary: string; quotes: { text: string; url: string; source: string }[] }
interface WalkRoute { name: string; coordinates: [number, number][]; distanceM: number; durationS: number; start: [number, number]; startLabel: string; via: string }
type AskEvent =
  | { type: 'step'; id: number; label: string; status: 'run' | 'done' | 'fail' }
  | { type: 'pins'; pins: MapPlace[] }
  | { type: 'route'; route: WalkRoute | null }
  | { type: 'focus'; target: 'pins' | 'route' | 'area' | 'pin'; pin: number; zoom: number }
  | { type: 'open_activity'; id: string }
  | { type: 'open_chat'; draft: string }
  | { type: 'go_to'; place: { lat: number; lng: number; locality: string; city: string; region?: string; country?: string } }
  | { type: 'ask_location'; question: string; options: string[] }
  | { type: 'spot'; spot: Spot }
  | { type: 'reviews'; reviews: PlaceReviews }
  | { type: 'answer'; answer: string; mode: 'claude' | 'guide' | 'blocked'; note?: string }
  | { type: 'error'; error: string };

interface AskOptions {
  map: () => maplibregl.Map;
  place: () => Place | undefined;
  activities: () => Activity[];
  /** Fly the whole app to another area (the globe landing). */
  goTo: (place: Place) => void;
}

const SUGGESTIONS = ['Best walking track', 'Coffee nearby, then walk me there', 'Open the next event', 'Help me invite people for a walk', 'Take me to Shibuya'];
const ROUTE = 'ask-route';

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const richText = (value: string) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n+/g, '<br>');
const km = (m: number) => (m / 1000).toFixed(1) + ' km';
const instant = () => document.documentElement.classList.contains('instant');

export function mountAsk(options: AskOptions) {
  const root = document.createElement('section');
  root.className = 'ask';
  root.setAttribute('aria-label', 'Ask about this area');
  root.innerHTML = `
    <div class="ask-card" hidden>
      <header class="ask-head">
        <span class="ask-kicker"><i></i><span class="ask-where">Local guide</span></span>
        <button type="button" class="ask-close" aria-label="Close answer and clear the map">×</button>
      </header>
      <p class="ask-question"></p>
      <p class="ask-spot" hidden><span aria-hidden="true">◎</span> <span class="ask-spot-label"></span> · <button type="button" class="ask-spot-change">change</button></p>
      <ol class="ask-steps" aria-label="What the guide is doing"></ol>
      <div class="ask-body" aria-live="polite"></div>
      <div class="ask-locate" hidden>
        <div class="ask-locate-options"></div>
        <button type="button" class="ask-locate-gps">◎ Use my exact location</button>
        <button type="button" class="ask-locate-other">Somewhere else…</button>
      </div>
      <div class="ask-route" hidden>
        <div class="ask-stat"><b class="ask-distance"></b><small>Distance</small></div>
        <div class="ask-stat"><b class="ask-time"></b><small>On foot</small></div>
        <div class="ask-stat wide"><b class="ask-start"></b><small class="ask-start-label">Starts at</small></div>
      </div>
      <ol class="ask-places"></ol>
      <footer class="ask-source"></footer>
    </div>
    <div class="ask-chips" role="list"></div>
    <form class="ask-bar" autocomplete="off">
      <span class="ask-glyph" aria-hidden="true">?</span>
      <input name="q" maxlength="300" placeholder="Ask about this area…" aria-label="Ask about this area" />
      <button type="submit">Ask</button>
    </form>`;
  document.querySelector('#app')!.append(root);

  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const card = $('.ask-card'), body = $('.ask-body'), input = $<HTMLInputElement>('input'), form = $<HTMLFormElement>('.ask-bar');
  const chips = $('.ask-chips'), placesList = $('.ask-places'), routeBox = $('.ask-route'), steps = $('.ask-steps');
  chips.innerHTML = SUGGESTIONS.map(s => `<button type="button" role="listitem">${escapeHtml(s)}</button>`).join('');

  // What the guide has put on the map. Sent back with each question so follow-ups work.
  let pins: MapPlace[] = [];
  let route: WalkRoute | null = null;
  let markers: maplibregl.Marker[] = [];
  let flag: maplibregl.Marker | undefined;
  let history: { role: 'user' | 'assistant'; text: string }[] = [];
  // Where the visitor really is, once they confirm it. Cleared when the area changes.
  let spot: Spot | null = null;
  let youMarker: maplibregl.Marker | undefined;
  let pendingQuestion = '';
  let typingSpot = false;
  let reviews = new Map<number, PlaceReviews>();
  let historyPlace: Place | undefined;
  let controller: AbortController | undefined;
  let cameraTaken = false; // Claude moved the camera itself: stop auto-fitting
  let travelling = false;
  let fitTimer = 0;

  // ------------------------------------------------------------ map drawing
  function drawPins() {
    markers.forEach(m => m.remove());
    markers = pins.map((place, index) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'ask-pin';
      pin.dataset.ask = String(index);
      pin.innerHTML = `<b>${index + 1}</b><span>${escapeHtml(place.name)}</span>`;
      pin.onclick = event => { event.stopPropagation(); focusPin(index + 1); };
      const marker = new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(options.map());
      pin.setAttribute('aria-label', `${index + 1}. ${place.name}`);
      return marker;
    });
    placesList.innerHTML = pins.map((p, i) => {
      const line = [p.address, p.detail].filter(Boolean).join(' · ');
      const r = reviews.get(i + 1);
      const said = r ? `
        <div class="ask-review ${r.sentiment}">
          <p><i>${{ positive: 'Liked', mixed: 'Mixed', negative: 'Not liked', unknown: 'No reviews found' }[r.sentiment]}</i> ${escapeHtml(r.summary)}</p>
          ${r.quotes.map(q => `<blockquote>“${escapeHtml(q.text)}” <a href="${escapeHtml(q.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(q.source)} ↗</a></blockquote>`).join('')}
        </div>` : '';
      return `<li${r ? ' class="has-review"' : ''}><button type="button" data-index="${i}"><b>${i + 1}</b><span>${escapeHtml(p.name)}${line ? `<small>${escapeHtml(line)}</small>` : ''}</span><em>${km(p.distanceM)}</em></button>${said}</li>`;
    }).join('');
    document.querySelectorAll('.ask-pin').forEach(pin => pin.classList.toggle('has-review', reviews.has(Number((pin as HTMLElement).dataset.ask) + 1)));
    placesList.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.onclick = () => focusPin(Number(b.dataset.index) + 1); });
  }

  function showSpot() {
    youMarker?.remove();
    youMarker = undefined;
    $('.ask-spot').hidden = !spot;
    if (!spot) return;
    $('.ask-spot-label').textContent = 'Near ' + spot.label;
    const element = document.createElement('div');
    element.className = 'ask-you';
    element.innerHTML = '<i></i><span>You</span>';
    youMarker = new maplibregl.Marker({ element }).setLngLat([spot.lng, spot.lat]).addTo(options.map());
  }

  function askWhere(question: string, choices: string[]) {
    const box = $('.ask-locate');
    box.hidden = false;
    $('.ask-locate-options').innerHTML = `<p>${escapeHtml(question)}</p>` +
      choices.map(c => `<button type="button" class="ask-locate-option">${escapeHtml(c)}</button>`).join('');
    box.querySelectorAll<HTMLButtonElement>('.ask-locate-option').forEach(b => { b.onclick = () => answerWhere({ query: b.textContent || '' }); });
  }

  /** The visitor said where they are: ask the waiting question again from there. */
  function answerWhere(where: { query?: string; spot?: Spot }) {
    $('.ask-locate').hidden = true;
    typingSpot = false;
    setLabel();
    if (where.spot) { spot = where.spot; showSpot(); }
    void ask(pendingQuestion || 'What is good around here?', where.query);
  }

  function removeRoute() {
    const map = options.map();
    for (const id of [ROUTE + '-glow', ROUTE + '-casing', ROUTE + '-line', ROUTE + '-dash']) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(ROUTE)) map.removeSource(ROUTE);
    flag?.remove();
    flag = undefined;
  }

  function drawRoute() {
    removeRoute();
    routeBox.hidden = !route;
    if (!route) return;
    const map = options.map();
    map.addSource(ROUTE, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coordinates } } });
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f5bd52';
    const join = { 'line-join': 'round', 'line-cap': 'round' } as const;
    map.addLayer({ id: ROUTE + '-glow', type: 'line', source: ROUTE, layout: join, paint: { 'line-color': accent, 'line-width': 18, 'line-opacity': 0.18, 'line-blur': 6 } });
    map.addLayer({ id: ROUTE + '-casing', type: 'line', source: ROUTE, layout: join, paint: { 'line-color': '#101212', 'line-width': 9 } });
    map.addLayer({ id: ROUTE + '-line', type: 'line', source: ROUTE, layout: join, paint: { 'line-color': accent, 'line-width': 5.5 } });
    map.addLayer({ id: ROUTE + '-dash', type: 'line', source: ROUTE, layout: join, paint: { 'line-color': '#fff8e8', 'line-width': 1.6, 'line-dasharray': [0.5, 3] } });
    const element = document.createElement('div');
    element.className = 'ask-flag';
    const toPlace = route.name.startsWith('Walk to ');
    element.innerHTML = `<i></i><span>${escapeHtml(toPlace || route.startLabel === 'Area center' ? 'Start' : 'Start here')}</span>`;
    flag = new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat(route.start).addTo(map);
    $('.ask-distance').textContent = km(route.distanceM);
    $('.ask-time').textContent = Math.round(route.durationS / 60) + ' min';
    $('.ask-start').textContent = toPlace ? route.via : route.startLabel === 'Area center' ? 'Area center' : route.via;
    $('.ask-start-label').textContent = toPlace ? 'Destination' : 'Starts at';
  }

  function clearMap() {
    pins = []; route = null; reviews = new Map();
    drawPins(); drawRoute();
  }

  // ------------------------------------------------------------ camera
  function padding() {
    const compact = innerWidth <= 720;
    // With the chat open, the answer card is hidden and the chat panel sits on the right.
    if (document.body.classList.contains('chat-open')) {
      return compact ? { top: 90, bottom: innerHeight * 0.7, left: 30, right: 30 } : { top: 110, bottom: 60, left: Math.min(380, innerWidth * 0.32), right: 420 };
    }
    const rect = card.hidden ? root.getBoundingClientRect() : card.getBoundingClientRect();
    const pad = compact
      ? { top: Math.min(innerHeight * 0.6, rect.bottom + 30), bottom: 40, left: 40, right: 60 }
      : { top: 110, bottom: Math.max(60, innerHeight - rect.top + 30), left: Math.min(380, innerWidth * 0.32), right: 90 };
    if (innerHeight - pad.top - pad.bottom < 120) { pad.top = 60; pad.bottom = 60; }
    return pad;
  }

  function fitPoints(points: [number, number][], maxZoom = 16) {
    if (!points.length) return;
    const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
    options.map().fitBounds(bounds, { padding: padding(), maxZoom, duration: instant() ? 0 : 900 });
  }

  function fitAll() {
    const place = options.place();
    const points: [number, number][] = [...(route?.coordinates ?? []), ...pins.map(p => [p.lng, p.lat] as [number, number])];
    if (place && pins.length && !route) points.push([place.lng, place.lat]);
    fitPoints(points);
  }

  /** While Claude works, follow what it draws, unless it has taken the camera itself. */
  function followSoon() {
    if (cameraTaken) return;
    clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => requestAnimationFrame(fitAll), 250);
  }

  function focusPin(number: number, zoom = 0) {
    const place = pins[number - 1];
    if (!place) return;
    root.querySelectorAll('.ask-places li').forEach((li, i) => li.classList.toggle('is-on', i === number - 1));
    document.querySelectorAll('.ask-pin').forEach(pin => pin.classList.toggle('is-on', (pin as HTMLElement).dataset.ask === String(number - 1)));
    options.map().easeTo({ center: [place.lng, place.lat], zoom: zoom || Math.max(options.map().getZoom(), 16), duration: instant() ? 0 : 700 });
  }

  function focus(event: Extract<AskEvent, { type: 'focus' }>) {
    cameraTaken = true;
    clearTimeout(fitTimer);
    const map = options.map(), place = options.place();
    if (event.target === 'pin') return focusPin(event.pin, event.zoom);
    if (event.target === 'route' && route) return fitPoints(route.coordinates, event.zoom || 16);
    if (event.target === 'pins' && pins.length) return fitPoints(pins.map(p => [p.lng, p.lat]), event.zoom || 16);
    if (place) map.easeTo({ center: [place.lng, place.lat], zoom: event.zoom || 14, duration: instant() ? 0 : 900 });
  }

  // ------------------------------------------------------------ app actions
  function openActivity(id: string) {
    const row = [...document.querySelectorAll<HTMLElement>('.activity-item[data-event], .blip[data-event]')].find(el => el.dataset.event === id);
    cameraTaken = true;
    // The app's own handler opens the card and flies the map to it.
    window.setTimeout(() => row?.click(), 300);
  }

  function openChat(draft: string) {
    const launcher = document.querySelector<HTMLButtonElement>('#mobile-chat');
    const box = document.querySelector<HTMLInputElement>('#message-input');
    launcher?.click();
    window.setTimeout(() => {
      if (!box) return;
      box.value = draft;
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
    }, 350);
  }

  function goTo(target: Extract<AskEvent, { type: 'go_to' }>['place']) {
    travelling = true;
    cameraTaken = true;
    clearMap();
    window.setTimeout(() => options.goTo({ ...target, region: target.region ?? '', country: target.country ?? '', source: 'search' }), 900);
  }

  // ------------------------------------------------------------ mission log and answer
  function step(event: Extract<AskEvent, { type: 'step' }>) {
    let item = steps.querySelector<HTMLElement>(`[data-step="${event.id}"]`);
    if (!item) {
      item = document.createElement('li');
      item.dataset.step = String(event.id);
      steps.append(item);
    }
    item.className = event.status;
    item.innerHTML = `<i aria-hidden="true"></i><span>${escapeHtml(event.label)}</span>`;
  }

  function apply(event: AskEvent, question: string) {
    switch (event.type) {
      case 'step': return step(event);
      case 'pins':
        // New pin numbers mean old reviews no longer match.
        if (event.pins.some((p, i) => pins[i]?.name !== p.name)) reviews = new Map();
        pins = event.pins; drawPins(); return followSoon();
      case 'reviews': reviews.set(event.reviews.pin, event.reviews); return drawPins();
      case 'spot': spot = event.spot; showSpot(); return followSoon();
      case 'ask_location': pendingQuestion = question; return askWhere(event.question, event.options);
      case 'route': route = event.route; drawRoute(); return followSoon();
      case 'focus': return focus(event);
      case 'open_activity': return openActivity(event.id);
      case 'open_chat': openChat(event.draft); return followSoon();
      case 'go_to': return goTo(event.place);
      case 'error':
        body.innerHTML = `<span class="ask-error">${escapeHtml(event.error)}</span>`;
        return;
      case 'answer':
        body.innerHTML = richText(event.answer);
        $('.ask-source').textContent = 'Live OpenStreetMap data' + (route ? ' · walking route on real paths' : '') +
          (event.mode === 'claude' ? ' · Claude can move the map' : event.mode === 'blocked' ? ` · ${event.note ?? 'stopped by the safety check'}` : event.note ? ` · ${event.note}, built-in guide` : ' · built-in guide');
        history.push({ role: 'user', text: question }, { role: 'assistant', text: event.answer });
        history = history.slice(-6);
        if (!cameraTaken && (pins.length || route)) requestAnimationFrame(fitAll);
    }
  }

  async function ask(question: string, spotQuery?: string) {
    const place = options.place();
    question = question.trim();
    if (!place || question.length < 2) return;
    if (historyPlace !== place) { history = []; historyPlace = place; clearMap(); spot = null; showSpot(); }
    $('.ask-locate').hidden = true;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    cameraTaken = false;
    setLabel();
    card.hidden = false;
    document.body.classList.add('ask-open');
    root.classList.add('busy');
    $('.ask-question').textContent = question;
    steps.innerHTML = '';
    body.innerHTML = '<span class="ask-loading">Thinking<i></i></span>';
    $('.ask-source').textContent = '';
    try {
      const response = await fetch('/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          question, history, pins, routeName: route?.name, spot: spot ?? undefined, spotQuery,
          localTime: new Date().toLocaleString([], { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
          place: { lat: place.lat, lng: place.lng, locality: place.locality, city: place.city, region: place.region, country: place.country },
          activities: options.activities().slice(0, 15).map(a => ({ id: a.id, title: a.title, place: a.place, time: a.time, distance: Math.round(a.distance * 10) / 10 })),
        }),
      });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'The guide is unavailable. Try again.');
      }
      // Read newline-delimited JSON events as they arrive.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line && !signal.aborted) apply(JSON.parse(line) as AskEvent, question);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      body.innerHTML = `<span class="ask-error">${escapeHtml((error as Error).message || 'Something went wrong. Try again.')}</span>`;
    } finally {
      if (!signal.aborted) root.classList.remove('busy');
    }
  }

  function close() {
    controller?.abort();
    $('.ask-locate').hidden = true;
    typingSpot = false;
    card.hidden = true;
    root.classList.remove('busy');
    document.body.classList.remove('ask-open');
    clearMap();
  }

  function setLabel() {
    const place = options.place();
    input.placeholder = place ? `Ask about ${place.locality}…` : 'Ask about this area…';
    $('.ask-where').textContent = place ? `Local guide · ${place.locality}` : 'Local guide';
  }

  form.onsubmit = event => {
    event.preventDefault();
    const q = input.value.trim();
    input.value = '';
    if (typingSpot && q) return answerWhere({ query: q });
    void ask(q);
  };
  $('.ask-locate-other').onclick = () => {
    typingSpot = true;
    input.placeholder = 'Type the neighbourhood or landmark you are near…';
    input.focus();
  };
  $('.ask-locate-gps').onclick = () => {
    const button = $<HTMLButtonElement>('.ask-locate-gps');
    if (!navigator.geolocation) { button.textContent = 'Location is not available here'; return; }
    button.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      button.textContent = '◎ Use my exact location';
      answerWhere({ spot: { label: 'your exact location', lat: coords.latitude, lng: coords.longitude } });
    }, () => { button.textContent = 'Could not get your location. Pick an option or type one.'; }, { timeout: 9000, maximumAge: 300000 });
  };
  $('.ask-spot-change').onclick = () => {
    spot = null; showSpot();
    pendingQuestion = $('.ask-question').textContent || pendingQuestion;
    askWhere('Where are you near?', []);
  };
  chips.querySelectorAll<HTMLButtonElement>('button').forEach(chip => { chip.onclick = () => void ask(chip.textContent || ''); });
  $('.ask-close').onclick = () => { close(); input.focus({ preventScroll: true }); };
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !card.hidden) { event.stopPropagation(); close(); } });

  // Reset when the visitor changes area (unless the guide flew there), and warm the server cache.
  let lastPlace: Place | undefined;
  new MutationObserver(() => {
    const onMap = document.body.classList.contains('on-map');
    const place = options.place();
    if (!travelling && (!onMap || place !== lastPlace) && (!card.hidden || pins.length || route)) close();
    if (onMap && place && place !== lastPlace) {
      lastPlace = place;
      if (travelling) { travelling = false; history = []; historyPlace = place; }
      spot = null; showSpot();
      setLabel();
      void fetch('/api/ask/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: place.lat, lng: place.lng }) }).catch(() => undefined);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
