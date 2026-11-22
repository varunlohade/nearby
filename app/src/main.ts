import { openPrivateRoom } from './create/private-room';
import './styles.css';
import './atlas-hud.css';
import './free-roam.css';
import { StreetAtlas } from './world/atlas';
import { mountAsk } from './ask/ask';
import { mountLanding } from './landing/landing';
import { mountCreate, type Created } from './create/create';
import { mountCommunities } from './community/community';
import { chatPanel as createChatPanel } from './chat/panel';
import { EarthExperience, type Activity, type Place } from './world/earth';

import './ui/phone-map.css';
import { mountPhoneNavigation, type PhonePanel } from './ui/phone-navigation';
import { mountMarket } from './city/market';
import { mountGames } from './city/games';
import { cityScope } from './city/scope';
import './ui/daylight.css';
import './ui/trail-panel.css';

if (new URLSearchParams(location.search).has('instant')) document.documentElement.classList.add('instant');

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);

const canvas = $('#world') as HTMLCanvasElement;
const arrival = $('#arrival');
const arrivalTitle = $('#arrival-title');
const arrivalCopy = $('#arrival-copy');
const arrivalStatus = $('#arrival-status');
const progress = $('#progress');
const progressNumber = $('#progress-number');
const placePill = $('#place-pill');
const placePillLabel = $('#place-pill-label');
const globeButton = $('#globe-button');
const localityTitle = $('#locality-title');
const activityPanel = $('#activity-panel');
const activityList = $('#activity-list');
const chatPanel = $('#chat-panel');
const messageInput = $('#message-input') as HTMLInputElement;
const eventSheet = $('#event-sheet');
const placeCoords = $('#place-pill-coords');
const hud = $('#hud');
const mobileChat = $('#mobile-chat');
const locationDialog = $('#location-dialog') as HTMLDialogElement;
const searchInput = $('#location-search') as HTMLInputElement;
const searchResults = $('#search-results');

let world: EarthExperience;
let atlas: StreetAtlas;
let place: Place;
let activities: Activity[] = [];
let metadata: Record<string,string> = {};
let areaId = '';
let previewId = '';
let rsvpBusy = false;
const chat = createChatPanel(applyRoomState, updateAttendance);
function setProgress(value: number, status: string) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  progress.style.width = `${pct}%`;
  progressNumber.textContent = `${String(pct).padStart(2, '0')}%`;
  arrivalStatus.textContent = status;
}

async function detectPlace(): Promise<Place> {
  const providers = [
    { url: 'https://freeipapi.com/api/json', read: (data: any) => ({ lat: data.latitude, lng: data.longitude, city: data.cityName, region: data.regionName, country: data.countryName }) },
    { url: 'https://ipwho.is/', read: (data: any) => ({ lat: data.latitude, lng: data.longitude, city: data.city, region: data.region, country: data.country }) },
  ];
  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 2200);
      const response = await fetch(provider.url, {signal: controller.signal}).finally(() => clearTimeout(timeout));
      const data = await response.json();
      const found = provider.read(data);
      if (!response.ok || data.success === false || !Number.isFinite(found.lat) || Math.abs(found.lat) > 85.0511 || !Number.isFinite(found.lng) || Math.abs(found.lng) > 180 || !(found.city || found.region || found.country)) throw new Error('IP location unavailable');
      return {
        lat: found.lat, lng: found.lng,
        locality: found.city || found.region || found.country,
        city: found.city || found.region || found.country,
        region: found.region || '', country: found.country || '', source: 'network',
      };
    } catch { /* try the next provider */ }
  }
  return { lat: 17.466, lng: 78.357, locality: 'Kondapur', city: 'Hyderabad', region: 'Telangana', country: 'India', source: 'fallback' };
}

const hash = (text: string) => [...text].reduce((n, char) => Math.imul(n ^ char.charCodeAt(0), 2654435761), 2166136261) >>> 0;
interface LumaListing {
  id: string; title: string; url: string; cover?: string; count: number | null;
  lat: number; lng: number; venue: string; start: string; distance: number;
}
let lumaEvents: Activity[] = [];
// Rooms, events and audio sessions people created on the map near this area (see src/create).
let createdNear: Activity[] = [];
let create: ReturnType<typeof mountCreate> | undefined;
function createdActivity(item: Created): Activity {
  const x = 111.32 * ((item.lng - place.lng + 540) % 360 - 180) * Math.cos(place.lat * Math.PI / 180), z = 111.32 * (place.lat - item.lat);
  const time = item.kind === 'event' && item.start ? new Date(item.start).toLocaleString([], {dateStyle:'medium', timeStyle:'short'})
    : item.kind === 'audio' ? (item.live ? 'Live audio · ' + item.live + ' talking' : 'Audio session') : 'Chat room · open now';
  return {id:item.id, kind:item.kind === 'event' ? (item.category || 'social') : item.kind === 'audio' ? 'talk' : 'social', title:item.title,
    description:'', place:item.place, time, people:item.live ?? 0, distance:Math.hypot(x,z), x, z, venuePoint:[item.lng, item.lat]};
}
let listingStatus = '';
async function loadLuma(current: Place) {
  try {
    const response = await fetch('/api/luma/nearby?lat=' + current.lat.toFixed(2) + '&lng=' + current.lng.toFixed(2));
    if (!response.ok) throw new Error();
    const {events} = await response.json() as {events:LumaListing[]};
    if (current !== place) return;
    lumaEvents = events.map(e => ({id:e.id, title:e.title, kind:'social', description:'', place:e.venue,
      time:new Date(e.start).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}), people:e.count ?? 0, distance:e.distance,
      x:0,z:0,venuePoint:[e.lng,e.lat],luma:{url:e.url, cover:e.cover,count:e.count}}));
    listingStatus = lumaEvents.length ? 'Luma events within 50 km' : 'No public Luma venues within 50 km';
  } catch {
    if (current !== place) return;
    listingStatus = 'Luma events unavailable';
  }
  refreshListings();
}

function iconFor(kind: string) {
  const icons: Record<string, string> = {
    talk: '<svg viewBox="0 0 24 24"><path d="M5 5h14v10H9l-4 4V5Z"/></svg>',
    sport: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="m8 6 4 3 4-3M8 18l1-5-5-2m12 7-1-5 5-2M9 13h6"/></svg>',
    culture: '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13M9 9l10-2"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    social: '<svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3"/><circle cx="17" cy="8" r="2"/><path d="M3 19c0-3 2-5 5-5s5 2 5 5m1-5c3 0 5 2 5 5"/></svg>',
    wellness: '<svg viewBox="0 0 24 24"><path d="M12 21c-4-3-7-6-7-11a7 7 0 0 1 14 0c0 5-3 8-7 11Z"/><path d="M8 12c3 0 5-2 5-5 2 2 3 4 3 6"/></svg>',
    help: '<svg viewBox="0 0 24 24"><path d="M12 21s-8-4.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.5-8 11-8 11Z"/></svg>',
  };
  return icons[kind] || icons.talk;
}

const peopleIcon = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0M16 4.8a3.2 3.2 0 0 1 0 6.4M18 14a6 6 0 0 1 3 5.5"/></svg>';
const kindLabel: Record<string, string> = { talk: 'Talk', sport: 'Sport', culture: 'Music', social: 'Meetup', wellness: 'Outdoors', help: 'Community' };
const formatCoords = (lat: number, lng: number) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;

function renderActivities(landing = true) {
  activityList.innerHTML = activities.map((item, index) => `
    <button class="activity-item type-${item.kind}" type="button" data-event="${item.id}" style="--delay:${120 + index * 60}ms">
      <span class="kind-icon">${iconFor(item.kind)}</span>
      <span class="activity-copy"><b>${escapeHtml(item.title)}</b><small class="mono">${escapeHtml(item.time)} · ${item.distance.toFixed(1)} km</small></span>
      <span class="going mono">${item.luma?.count === null ? '' : peopleIcon + item.people}</span>
    </button>`).join('');

  // Created items draw their own pins (src/create), so the atlas skips them.
  atlas.show(place, activities.filter(item => !create?.has(item.id)), item => {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `blip type-${item.kind}`;
    pin.dataset.event = item.id;
    pin.setAttribute('aria-label', item.title);
    pin.innerHTML = `<span class="blip-face">${iconFor(item.kind)}</span><span class="blip-name">${item.luma ? 'Luma' : kindLabel[item.kind]}</span>`;
    return pin;
  }, landing);

  // Hovering a list row lights up its pin, and the other way round.
  const setHot = (id: string | undefined, on: boolean) => {
    if (!id) return;
    document.querySelectorAll(`[data-event="${id}"]`).forEach((node) => node.classList.toggle('is-hot', on));
  };
  document.querySelectorAll<HTMLElement>('.activity-item, .blip').forEach((node) => {
    node.addEventListener('mouseenter', () => setHot(node.dataset.event, true));
    node.addEventListener('mouseleave', () => setHot(node.dataset.event, false));
  });
}

function setActive(id: string | null) {
  document.querySelectorAll('.is-active').forEach((node) => node.classList.remove('is-active'));
  document.body.classList.toggle('waypoint-open', Boolean(id));
  if (id) document.querySelectorAll(`[data-event="${id}"]`).forEach((node) => node.classList.add('is-active'));
}

let opener: HTMLElement | null = null;

let requestedBoard: HTMLElement | undefined;
document.addEventListener('click', event => {
  const trigger = (event.target as Element).closest<HTMLElement>('[data-city-games],[data-city-market]');
  if (!trigger || (place && cityScope(place))) return;
  event.stopImmediatePropagation();
  requestedBoard = trigger;
  searchVersion++;
  searchResults.textContent = 'Choose a city to see local listings and games.';
  locationDialog.showModal();
  searchInput.focus();
}, true);

const phoneActivities = $<HTMLButtonElement>('#phone-activities');
function showPhoneActivities(open: boolean) {
  activityPanel.classList.toggle('phone-open', open);
  phoneActivities.setAttribute('aria-expanded', String(open));
}
phoneActivities.onclick = () => showPhoneActivities(!activityPanel.classList.contains('phone-open'));
document.addEventListener('click', event => {
  const clicked = event.target as Element;
  if (!clicked.closest('#phone-activities,#activity-panel') || clicked.closest('#activity-panel button')) showPhoneActivities(false);
  const trigger = clicked.closest<HTMLButtonElement>('[data-map-action]');
  const action = trigger?.dataset.mapAction;
  if (trigger && action) {
    const menu = $('#phone-options');
    if (menu.matches(':popover-open')) menu.hidePopover();
    if (action === '#host-start') startCreate(trigger);
    else $<HTMLButtonElement>(action)?.click();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && activityPanel.classList.contains('phone-open')) {
    showPhoneActivities(false);
    phoneActivities.focus();
  }
});

function openEvent(id: string, trigger: HTMLElement) {
  if (create?.has(id)) { closeEvent(); setChatOpen(false); create.open(id); return; }
  const event = activities.find((item) => item.id === id);
  if (!event) return;
  setChatOpen(false);
  void chat.openArea();
  previewId = id;
  opener = trigger.closest('#activity-panel') && matchMedia('(max-width: 720px)').matches ? phoneActivities : trigger;
  eventSheet.className = `event panel type-${event.kind}`;
  $('#event-status').textContent = '';
  $('#event-kind').textContent = event.luma ? 'Luma event' : kindLabel[event.kind] + ' / Hosted event';
  $('#poster-title').textContent = event.luma ? '' : kindLabel[event.kind];
  const photo = $('#event-image') as HTMLImageElement;
  photo.src = event.luma?.cover || '/posters/' + event.kind + '.jpg';
  const link = $<HTMLAnchorElement>('#luma-link');
  link.hidden = !event.luma;
  link.href = event.luma?.url || '';
  $('#event-title').textContent = event.title;
  $('#event-description').textContent = event.description;
  $('#event-place').textContent = event.place;
  $('#event-time').textContent = event.time;
  const predictions = $('#event-predictions');
  predictions.hidden = event.kind !== 'sport';
  predictions.dataset.gameTitle = event.title;
  predictions.dataset.gameVenue = event.place;
  $('#event-distance').textContent = `${event.distance.toFixed(1)} km`;
  updateAttendance();
  setActive(id);
  atlas.focus(id, eventSheet);
  $('#sheet-close').focus({preventScroll: true});
}

function closeEvent(restoreFocus = false) {
  previewId = '';
  eventSheet.classList.add('hidden');
  atlas.closePreview();
  $('#app').append(eventSheet);
  setActive(null);
  if (restoreFocus) opener?.focus({preventScroll: true});
  opener = null;
}

function openMapConversation(id:string,title:string,kind:string) {
  closeEvent();
  if (/^p[a-f0-9]{12}$/.test(id)) { openPrivateRoom(id,title,chat.user.name); return; }
  void chat.openRoom(id,title,kind); setChatOpen(true, {type: 'room', id, title, kind});
}

let chatRoute: PhonePanel = {type: 'chat'};
function setChatOpen(open: boolean, route: PhonePanel = {type: 'chat'}) {
  chatRoute = route;
  if (open && document.body.classList.contains('roam-open')) document.body.append(chatPanel);
  else if (chatPanel.parentElement === document.body) $('#app').append(chatPanel);
  chatPanel.classList.toggle('collapsed', !open);
  document.body.classList.toggle('chat-open', open);
  if (open) { closeEvent(); messageInput.focus({ preventScroll: true }); }
}

function updateAttendance() {
  const item = activities.find(activity => activity.id === previewId);
  if (!item) return;
  const button = $<HTMLButtonElement>('#rsvp');
  button.hidden = !!item.luma;
  if (item.luma) {
    $('#event-people').textContent = item.luma.count === null ? 'Guest count private' : item.people + ' attending';
    $('#guest-names').textContent = '';
    $('#event-guests').replaceChildren();
    return;
  }
  const prefix = 'going_' + item.id + '_';
  const confirmed = Object.entries(metadata).filter(([k,v]) => k.startsWith(prefix) && typeof v === 'string').map(([,name]) => name.slice(0,40));
  const guests = confirmed.slice(0,3);
  const count = confirmed.length + item.people;
  $('#event-people').textContent = count + ' attending';
  $('#guest-names').textContent = guests.join(', ') + (count > guests.length ? ' + ' + (count - guests.length) + ' more' : '');
  $('#event-guests').replaceChildren(...guests.map(name => {
    const avatar = document.createElement('span'); avatar.textContent = name[0]; return avatar;
  }));
  const going = Object.hasOwn(metadata,prefix + chat.user.userId);
  button.disabled = !chat.areaReady || rsvpBusy;
  button.setAttribute('aria-pressed', String(going));
  button.textContent = going ? '✓ Going' : 'RSVP';
}

function hostedActivities(values: Record<string,string>): Activity[] {
  const result: Activity[] = [];
  for (const [id,raw] of Object.entries(values)) {
    if (!/^event_[a-f0-9]{24}$/.test(id)) continue;
    try {
      const data = JSON.parse(raw);
      if (typeof data.title !== 'string' || typeof data.venue !== 'string' || !Object.hasOwn(kindLabel,data.kind) ||
          !Number.isFinite(data.lat) || Math.abs(data.lat) > 85.0511 || !Number.isFinite(data.lng) || Math.abs(data.lng) > 180 ||
          !Number.isFinite(data.start) || data.start < Date.now() - 86400000) continue;
      const x = 111.32 * ((data.lng-place.lng+540)%360-180) * Math.cos(place.lat*Math.PI/180);
      const z = 111.32 * (place.lat-data.lat);
      result.push({id,kind:data.kind,title:data.title.slice(0,75),place:data.venue.slice(0,70),description:'',people:0,
        time:new Date(data.start).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}),
        venuePoint:[data.lng,data.lat], distance:Math.hypot(x,z), x,z});
    } catch { /* Ignore entries from other clients that do not describe an event. */ }
  }
  return result.sort((a,b) => a.id.localeCompare(b.id));
}

function refreshListings() {
  const hosted = hostedActivities(metadata);
  activities = [...hosted,...createdNear,...lumaEvents];
  renderActivities(false);
  $('#activity-count').textContent = String(activities.length);
  const made = hosted.length + createdNear.length;
  $('#activity-caption').textContent = (made ? made + ' made here · ' : '') + listingStatus;
  if (previewId && !activities.some(item => item.id === previewId)) closeEvent();
  updateAttendance();
}

function applyRoomState(values: Record<string,string>) {
  metadata = {...values};
  if (JSON.stringify(hostedActivities(metadata)) !== JSON.stringify(activities.filter(item => !item.luma))) refreshListings();
  else updateAttendance();
}

function connectArea(current: Place) {
  const key = [current.country,current.region,current.city,current.locality].map(s => s.trim().normalize('NFKC').toLowerCase()).join('|');
  areaId = 'nearby_' + hash(key).toString(36) + '_' + hash([...key].reverse().join('')).toString(36);
  return chat.setArea({id:areaId, title:current.locality + ' chat'});
}

function selectPlace(nextPlace: Place, landing: boolean) {
  place = nextPlace;
  metadata = {};
  lumaEvents = [];
  createdNear = [];
  activities = [];
  create?.refresh();
  listingStatus = 'Finding Luma events…';
  $('#activity-caption').textContent = listingStatus;
  $('#activity-count').textContent = '0';
  renderActivities(landing);
  void connectArea(place);
  void loadLuma(place);
}

function showPlaceLabel() {
  placePillLabel.textContent = place.locality;
  localityTitle.textContent = place.locality;

  $('#launcher-room').textContent = `${place.locality} chat`;
  placeCoords.textContent = `${place.lat.toFixed(2)}°, ${place.lng.toFixed(2)}°`;
  $('#hud-coords').textContent = place.source === 'fallback' ? 'Default area · change above' : [place.region, place.country].filter(Boolean).join(' / ');
}

async function landAt(nextPlace: Place) {
  world.exploring = false;
  document.body.classList.remove('orbit-explore');
  selectPlace(nextPlace, true);
  closeEvent();
  globeButton.classList.add('hidden');
  placePill.classList.add('hidden');
  document.body.classList.remove('on-map', 'landing-map');
  arrival.hidden = false;
  arrival.classList.remove('hidden');
  activityPanel.classList.add('hidden');
  chatPanel.classList.add('hidden');
  setChatOpen(false);
  mobileChat.classList.add('hidden');
  hud.classList.add('hidden');
  eventSheet.classList.add('hidden');
  $('#arrival-kicker').textContent = formatCoords(place.lat, place.lng);
  arrivalTitle.innerHTML = `Landing in<br /><em>${escapeHtml(place.locality)}.</em>`;
  const sourceLabel = place.source === 'network' ? 'network' : place.source === 'device' ? 'device' : place.source === 'search' ? 'search' : place.source === 'globe' ? 'globe selection' : 'default region';
  arrivalCopy.textContent = place.source === 'fallback' ? 'Demo area · you can change it after landing' :
    [place.city, place.region !== place.city ? place.region : '', sourceLabel].filter(Boolean).join(' · ');
  setProgress(38, 'Aligning the globe');
  await world.flyTo(place, (value, label) => {
    setProgress(38 + value * 47, label);
    // Start the street map's fade during the last stretch of the descent, so the
    // globe and the map overlap instead of meeting at a plain frame.
    if (value > 0.85) document.body.classList.add('landing-map');
  });
  setProgress(88, 'Opening the street map');
  document.body.classList.add('landing-map');
  await atlas.land();
  setProgress(100, 'You’re here');
  arrival.classList.add('hidden');
  showPlaceLabel();
  hud.classList.remove('hidden');
  $('#activity-count').textContent = String(activities.length);
  document.body.classList.add('on-map');
  placePill.classList.remove('hidden');
  globeButton.classList.remove('hidden');
  activityPanel.classList.remove('hidden');
  chatPanel.classList.remove('hidden');
  mobileChat.classList.remove('hidden');
  $('#attribution').classList.remove('hidden');
  document.body.classList.remove('landing-map');
}

async function start() {
  atlas = new StreetAtlas($('#street-atlas'), () => closeEvent());
  // Ask about my neighbourhood. atlas['map'] reads the private MapLibre instance on purpose.
  mountAsk({ map: () => atlas['map'], place: () => place, activities: () => activities, goTo: next => { void landAt(next); } });
  // Create a chat room, event or audio session anywhere on the map.
  create = mountCreate({
    map: () => atlas['map'], place: () => place, user: () => chat.user,
    openChat: openMapConversation,
    onNearby: items => {
      if (!place) return;
      const next=items.map(createdActivity);
      if(JSON.stringify(next)===JSON.stringify(createdNear))return;
      createdNear=next;refreshListings();
    },
  });
  mountCommunities({
    map: () => atlas['map'], place: () => place, user: () => chat.user,
    openChat: openMapConversation,
  });
  mountMarket(() => place);
  mountGames(() => place);
  mountPhoneNavigation(() => {
    if (document.body.classList.contains('chat-open')) return chatRoute;
    if (previewId) return {type: 'preview', id: previewId};
    if (activityPanel.classList.contains('phone-open')) return {type: 'activities'};
  }, route => {
    if (previewId) { closeEvent(true); atlas.home(); }
    if (document.body.classList.contains('chat-open')) $('#chat-close').click();
    showPhoneActivities(route?.type === 'activities');
    if (!route || route.type === 'activities') return;
    if (route.type === 'chat') { mobileChat.click(); return; }
    if (route.type === 'room') {
      openMapConversation(route.id, route.title, route.kind);
      return;
    }
    const id = route.id;
    const row = activityList.querySelector<HTMLElement>(`[data-event="${CSS.escape(id)}"]`);
    if (row) {
      openEvent(id, row);
      if (route.type === 'event-chat') $('#join-conversation').click();
    }
  });
  const landing = mountLanding();
  world = new EarthExperience(canvas);
  world.enableNavigation(canvas, (lat,lng) => { void landOnGlobe(lat,lng); });
  if (new URLSearchParams(location.search).has('globe')) {
    await world.ready((v,label) => setProgress(v*100,label));
    showExplorer(); return;
  }
  // Shared links (?at=lat,lng) land straight on that spot.
  const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
  if (at?.length === 2 && at.every(Number.isFinite)) {
    setProgress(8, 'Building Earth');
    await world.ready((value, label) => setProgress(8 + value * 25, label));
    await landAt(await placeAt(at[0], at[1]));
    return;
  }
  setProgress(8, 'Building Earth');
  const [detected] = await Promise.all([
    detectPlace(),
    world.ready((value, label) => setProgress(8 + value * 25, label)),
  ]);
  // First-time visitors read what nearby does, then press "Explore".
  setProgress(36, 'Globe ready');
  await landing.ready(detected.locality);
  await landAt(detected);
}

document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-event]');
  if (button?.dataset.event) openEvent(button.dataset.event, button);
});
$('#sheet-close').onclick = () => { closeEvent(true); atlas.home(); };
$('#join-conversation').onclick = () => {
  const item = activities.find(activity => activity.id === previewId);
  if (item) {
    void chat.openEvent(item.id,item.title);
    setChatOpen(true, {type: 'event-chat', id: item.id});
  }
};
$('#rsvp').onclick = async () => {
  const id = previewId;
  const area = areaId;
  const key = 'going_' + id + '_' + chat.user.userId;
  rsvpBusy = true; updateAttendance();
  try { await chat.write(key, Object.hasOwn(metadata,key) ? null : chat.user.name); }
  catch (e) { if (previewId === id && area === areaId) $('#event-status').textContent = (e as Error).message; }
  finally { rsvpBusy = false; updateAttendance(); }
};
$('#chat-close').onclick = () => { setChatOpen(false); void chat.openArea(); };
mobileChat.onclick = () => { void chat.openArea(); setChatOpen(true); };
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog:modal')) return;
  if (!eventSheet.classList.contains('hidden')) closeEvent(true);
  else if (!chatPanel.classList.contains('collapsed')) { setChatOpen(false); void chat.openArea(); }
});
locationDialog.querySelector<HTMLButtonElement>('.dialog-close')!.onclick = () => locationDialog.close();
placePill.onclick = () => {
  requestedBoard = undefined;
  searchVersion++;
  locationDialog.showModal();
};
$('#map-plus').onclick = () => atlas.zoom(1);
$('#map-minus').onclick = () => atlas.zoom(-1);
$('#map-home').onclick = () => { closeEvent(); atlas.home(); };

globeButton.onclick = async () => {
  globeButton.classList.add('hidden');
  placePill.classList.add('hidden');
  document.body.classList.remove('on-map');
  arrival.hidden = false;
  activityPanel.classList.add('hidden');
  chatPanel.classList.add('hidden');
  setChatOpen(false);
  mobileChat.classList.add('hidden');
  hud.classList.add('hidden');
  closeEvent();
  await world.returnToGlobe();
  showExplorer();
};

function showExplorer() {
  world.exploring = true;
  document.body.classList.add('orbit-explore');
  $('#arrival-kicker').textContent = 'World map';
  arrivalTitle.innerHTML = 'Explore<br /><em>Earth.</em>';
  arrivalCopy.textContent = 'Drag to rotate. Scroll to zoom. Click a location to land.';
  arrival.classList.remove('hidden');
  placePillLabel.textContent = 'Search places';
  placePill.classList.remove('hidden');
}

async function placeAt(latitude:number, lng:number): Promise<Place> {
  const lat = Math.max(-85.05,Math.min(85.05,latitude));
  const fallback = lat.toFixed(1) + '°, ' + lng.toFixed(1) + '°';
  let locality = fallback, city = fallback, region = '', country = '';
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=' + lat.toFixed(3) + '&lon=' + lng.toFixed(3),{signal:AbortSignal.timeout(2200)});
    const {address} = await res.json();
    if (address) {
      city = address.city || address.town || address.village || address.county || fallback;
      locality = address.suburb || address.neighbourhood || city;
      region = address.state || ''; country = address.country || '';
    }
  } catch { /* The globe selection remains usable without a place name. */ }
  if (city === fallback && Math.abs(lat-17.466)<0.008 && Math.abs(lng-78.357)<0.008) {
    return {lat,lng,locality:'Kondapur',city:'Hyderabad',region:'Telangana',country:'India',source:'fallback'};
  }
  return {lat,lng,locality,city,region,country,source:'globe'};
}

async function landOnGlobe(lat:number, lng:number) {
  placePill.classList.add('hidden');
  arrivalCopy.textContent = 'Locating your selection…';
  await landAt(await placeAt(lat,lng));
}

const searchMapArea = $<HTMLButtonElement>('#search-map-area');
searchMapArea.onclick = async () => {
  const previous = place;
  const center = atlas.center;
  searchMapArea.disabled = true;
  searchMapArea.textContent = 'Finding area…';
  try {
    const next = await placeAt(center.lat,center.lng);
    if (previous !== place || !document.body.classList.contains('on-map') || center.distanceTo(atlas.center) > 700) return;
    closeEvent(); setChatOpen(false); atlas.clearWaypoint();
    selectPlace(next, false);
    showPlaceLabel();
  } finally {
    searchMapArea.disabled = false;
    searchMapArea.textContent = 'Search this area';
  }
};

const hostDialog = $<HTMLDialogElement>('#host-dialog');
const hostForm = $<HTMLFormElement>('#host-form');
let hostedId = '';
function startCreate(trigger: HTMLElement) {
  closeEvent(); setChatOpen(false); void chat.openArea();
  create?.start(trigger);
}
$('#host-start').onclick = event => startCreate(event.currentTarget as HTMLElement);
$('#host-here').onclick = () => {
  void chat.openArea();
  $('#host-status').textContent = '';
  hostedId = 'event_' + crypto.randomUUID().replaceAll('-','').slice(0,24);
  hostDialog.showModal();
};
$('#host-cancel').onclick = () => hostDialog.close();
hostForm.onsubmit = async e => {
  e.preventDefault();
  const at = atlas.venuePoint;
  if (!at) return;
  const form = new FormData(hostForm);
  const title = String(form.get('title')).trim(), venue = String(form.get('venue')).trim();
  const start = new Date(String(form.get('start'))).valueOf();
  if (!title || !venue || !Number.isFinite(start) || start <= Date.now()) {
    $('#host-status').textContent = 'Add a name, venue and future start time.'; return;
  }
  const button = hostForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  if (button.disabled) return;
  button.disabled = true;
  const id = hostedId;
  const area = areaId;
  try {
    await chat.write(id,JSON.stringify({title,venue,start,kind:form.get('kind'),lng:at[0],lat:at[1]}));
    hostDialog.close(); hostForm.reset();
    if (area !== areaId) return;
    $('#pin-clear').click();
    const row = activityList.querySelector<HTMLElement>('[data-event="' + id + '"]');
    if (row) openEvent(id,row);
    try { await chat.announce('New event: ' + title + ' · ' + venue + ' · ' + new Date(start).toLocaleString()); }
    catch { if (previewId === id) $('#event-status').textContent = 'Event published. Chat announcement could not be sent.'; }
  } catch (err) { $('#host-status').textContent = (err as Error).message; }
  finally { button.disabled = false; }
};

async function choosePickerPlace(next: Place) {
  const trigger = requestedBoard;
  if (trigger && !cityScope(next)) {
    searchResults.textContent = 'Choose a named city to continue.';
    searchInput.focus();
    return;
  }
  requestedBoard = undefined;
  locationDialog.close();
  await landAt(next);
  if (trigger && place === next) {
    const board = trigger.hasAttribute('data-city-games') ? 'games' : 'market';
    (trigger.isConnected ? trigger : $(`.phone-dock [data-city-${board}]`)).click();
  }
}

let searchTimer = 0;
let searchVersion = 0;
const preciseLabel = $('#precise-location span');
locationDialog.addEventListener('close', () => {
  if (locationDialog.open) return;
  requestedBoard = undefined;
  preciseLabel.textContent = 'Use my current location';
  searchVersion++;
  clearTimeout(searchTimer);
  searchResults.replaceChildren();
  searchInput.value = '';
});
searchInput.addEventListener('input', () => {
  const version = ++searchVersion;
  preciseLabel.textContent = 'Use my current location';
  window.clearTimeout(searchTimer);
  searchResults.replaceChildren();
  const query = searchInput.value.trim();
  if (query.length < 3) { searchResults.innerHTML = ''; return; }
  searchTimer = window.setTimeout(async () => {
    searchResults.innerHTML = '<span class="searching">Searching the world…</span>';
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(query)}`);
      const results = await response.json();
      if (version !== searchVersion) return;
      searchResults.innerHTML = results.map((result: any, index: number) => `<button type="button" data-result="${index}"><b>${escapeHtml(result.name || result.display_name.split(',')[0])}</b><span>${escapeHtml(result.display_name)}</span></button>`).join('') || '<span class="searching">No matching place found.</span>';
      searchResults.querySelectorAll<HTMLButtonElement>('[data-result]').forEach((button) => {
        button.onclick = () => {
          const result = results[Number(button.dataset.result)];
          const address = result.address || {};
          const locality = result.name || address.suburb || address.city || address.town || address.village;
          const city = address.city || address.town || address.village ||
            (!requestedBoard || ['city', 'town', 'village'].includes(result.addresstype) ? locality : '');
          void choosePickerPlace({ lat: Number(result.lat), lng: Number(result.lon), locality, city, region: address.state || '', country: address.country || '', source: 'search' });
        };
      });
    } catch { if (version === searchVersion) searchResults.innerHTML = '<span class="searching">Search is unavailable. Try again.</span>'; }
  }, 350);
});

$('#precise-location').onclick = () => {
  const version = ++searchVersion;
  const current = () => locationDialog.open && version === searchVersion;
  const label = preciseLabel;
  if (!navigator.geolocation) { label.textContent = 'Location is unavailable in this browser'; return; }
  label.textContent = 'Finding your precise area…';
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    if (!current()) return;
    let locality = 'Your location', city = 'Your location', region = '', country = '';
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.latitude}&lon=${coords.longitude}&zoom=14&addressdetails=1`);
      const result = await response.json();
      const address = result.address || {};
      locality = address.suburb || address.neighbourhood || address.city_district || address.city || locality;
      city = address.city || address.town || address.village || (requestedBoard ? '' : locality);
      region = address.state || '';
      country = address.country || '';
    } catch { /* coordinates are still usable */ }
    if (!current()) return;
    label.textContent = 'Use my current location';
    void choosePickerPlace({ lat: coords.latitude, lng: coords.longitude, locality, city, region, country, source: 'device' });
  }, () => { if (current()) label.textContent = 'Could not access location — try search'; }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 });
};

void start();
