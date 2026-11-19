// Shared mock data + helpers for the three directions. Static mockup only.
const C = {};

C.STYLE = 'https://tiles.openfreemap.org/styles/positron';
C.q = new URLSearchParams(location.search);
C.screen = C.q.get('s') || '1';
C.desk = C.q.get('desk') === '1';

// Lisbon, a real city with real neighbourhood names. Centers are approximate.
C.areas = [
  { id: 'graca', name: 'Graça', c: [-9.1312, 38.7178], now: 14, members: 212, mine: true,
    post: { who: 'Inês', ago: 'now', text: 'Sunset on the miradouro on Friday. Who is in?' } },
  { id: 'alfama', name: 'Alfama', c: [-9.1296, 38.7118], now: 31, members: 486,
    post: { who: 'Rui', ago: '2 min', text: 'The bakery on Rua de São Miguel has pastéis de nata again.' } },
  { id: 'mouraria', name: 'Mouraria', c: [-9.1352, 38.7160], now: 6, members: 98,
    post: { who: 'Leila', ago: '9 min', text: 'Lost a grey cat near Intendente. Answers to Bolo.' } },
  { id: 'baixa', name: 'Baixa', c: [-9.1376, 38.7104], now: 22, members: 301,
    post: { who: 'Tom', ago: '4 min', text: 'Slow run by the river on Sunday. All paces welcome.' } },
  { id: 'chiado', name: 'Chiado', c: [-9.1420, 38.7108], now: 9, members: 174,
    post: { who: 'Marta', ago: '12 min', text: 'Book swap on the steps. Bring one, take one.' } },
  { id: 'bairro', name: 'Bairro Alto', c: [-9.1454, 38.7136], now: 40, members: 522,
    post: { who: 'João', ago: '1 min', text: 'Street dinner is on. Bring a chair and a dish.' } },
  { id: 'principe', name: 'Príncipe Real', c: [-9.1492, 38.7170], now: 3, members: 61,
    post: { who: 'Sofia', ago: '20 min', text: 'The garden market moved to the far side of the park.' } },
  { id: 'anjos', name: 'Anjos', c: [-9.1360, 38.7256], now: 11, members: 140,
    post: { who: 'Ana', ago: '6 min', text: 'Does anyone have a ladder I can borrow today?' } },
  // Unclaimed areas: anyone can build these.
  { id: 'penha', name: 'Penha de França', c: [-9.1290, 38.7262], empty: true },
  { id: 'santana', name: "Sant'Ana", c: [-9.1414, 38.7206], empty: true },
  { id: 'vicente', name: 'São Vicente', c: [-9.1236, 38.7152], empty: true },
  { id: 'castelo', name: 'Castelo', c: [-9.1330, 38.7133], empty: true },
  { id: 'restauradores', name: 'Restauradores', c: [-9.1418, 38.7160], empty: true },
];
C.byId = Object.fromEntries(C.areas.map(a => [a.id, a]));

C.events = [
  { id: 'e1', area: 'graca', title: 'Sunset on the miradouro', day: 'Fri', date: '20', time: '6:30 pm', short: '6:30', place: 'Miradouro da Graça', at: [-9.1276, 38.7152], going: 12, emoji: '☀️' },
  { id: 'e2', area: 'alfama', title: 'Fado in the courtyard', day: 'Sat', date: '21', time: '9 pm', short: '9pm', place: 'Largo do Chafariz de Dentro', at: [-9.1270, 38.7102], going: 28, emoji: '🎸' },
  { id: 'e3', area: 'chiado', title: 'Book swap on the steps', day: 'Sun', date: '22', time: '11 am', short: '11am', place: 'Largo do Carmo', at: [-9.1432, 38.7092], going: 9, emoji: '📚' },
  { id: 'e4', area: 'anjos', title: 'Plant cuttings swap', day: 'Sat', date: '21', time: '10 am', short: '10am', place: 'Jardim Constantino', at: [-9.1334, 38.7242], going: 7, emoji: '🌱' },
  { id: 'e5', area: 'baixa', title: 'Slow run by the river', day: 'Sun', date: '22', time: '8 am', short: '8am', place: 'Praça do Comércio', at: [-9.1362, 38.7084], going: 15, emoji: '🏃' },
  { id: 'e6', area: 'bairro', title: 'Street dinner', day: 'Fri', date: '20', time: '8 pm', short: '8pm', place: 'Rua da Rosa', at: [-9.1470, 38.7150], going: 34, emoji: '🍝' },
];

C.room = {
  area: 'graca',
  msgs: [
    { who: 'Inês', text: 'Sunset on the miradouro on Friday. Who is in?', t: '5:02 pm' },
    { who: 'Tomás', text: 'In. I can bring the folding chairs.', t: '5:04 pm' },
    { event: 'e1', who: 'Inês' },
    { who: 'Carla', text: 'Can I bring my two kids?', t: '5:11 pm' },
    { me: true, text: 'Count me in. I will bring tea for the group.', t: '5:14 pm' },
  ],
};

C.initials = n => n.trim()[0].toUpperCase();

// ---------- geometry ----------
const R_EARTH_LAT = 110540;
const lngM = lat => 111320 * Math.cos(lat * Math.PI / 180);
C.toM = (p, o) => [(p[0] - o[0]) * lngM(o[1]), (p[1] - o[1]) * R_EARTH_LAT];
C.toLL = (m, o) => [o[0] + m[0] / lngM(o[1]), o[1] + m[1] / R_EARTH_LAT];
C.ORIGIN = [-9.1370, 38.7170];

function seeded(seed) { let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
C.seeded = seeded;

C.fc = features => ({ type: 'FeatureCollection', features });
C.poly = (ring, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
C.line = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
C.pt = (c, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });

// Organic blob around a center (direction B)
C.blob = (area, R = 200) => {
  const rnd = seeded(area.id);
  const f = [rnd() * 6, rnd() * 6, rnd() * 6], a = [0.16 + rnd() * 0.08, 0.08 + rnd() * 0.05, 0.04];
  const o = C.toM(area.c, C.ORIGIN), ring = [];
  for (let i = 0; i <= 72; i++) {
    const t = (i % 72) / 72 * Math.PI * 2;
    const r = R * (1 + a[0] * Math.sin(2 * t + f[0]) + a[1] * Math.sin(3 * t + f[1]) + a[2] * Math.sin(5 * t + f[2]));
    ring.push(C.toLL([o[0] + r * Math.cos(t), o[1] + r * Math.sin(t) * 0.92], C.ORIGIN));
  }
  return ring;
};

// Hex tiling (direction A). Pointy-top, R = circumradius in meters.
C.hexgrid = (R = 150, span = 2400) => {
  const W = Math.sqrt(3) * R, H = 1.5 * R, hexes = [];
  const rows = Math.ceil(span / H), cols = Math.ceil(span / W);
  for (let r = -rows; r <= rows; r++) for (let q = -cols - rows; q <= cols + rows; q++) {
    const x = W * (q + r / 2), y = H * r;
    if (Math.abs(x) > span * 1.1 || Math.abs(y) > span) continue;
    const corners = [];
    for (let i = 0; i < 6; i++) { const ang = Math.PI / 180 * (60 * i - 30); corners.push([x + R * Math.cos(ang), y + R * Math.sin(ang)]); }
    hexes.push({ x, y, corners, key: Math.round(x) + ',' + Math.round(y) });
  }
  // assign to nearest area center within radius
  for (const h of hexes) {
    let best = null, bd = 1e9;
    for (const a of C.areas) { const m = C.toM(a.c, C.ORIGIN); const d = Math.hypot(m[0] - h.x, m[1] - h.y); if (d < bd) { bd = d; best = a; } }
    const lim = best.empty ? 170 : 300;
    h.area = bd < lim ? best.id : null;
    h.d = bd;
  }
  const index = new Map(hexes.map(h => [h.key, h]));
  const near = (x, y) => { for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) { const k = (Math.round(x) + dx) + ',' + (Math.round(y) + dy); if (index.has(k)) return index.get(k); } return null; };
  // outer edges per area
  const edges = {};
  for (const h of hexes) {
    if (!h.area) continue;
    for (let i = 0; i < 6; i++) {
      const a = h.corners[i], b = h.corners[(i + 1) % 6];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const nb = near(2 * mx - h.x, 2 * my - h.y);
      if (!nb || nb.area !== h.area) (edges[h.area] ||= []).push([C.toLL(a, C.ORIGIN), C.toLL(b, C.ORIGIN)]);
    }
  }
  for (const h of hexes) { h.ring = [...h.corners, h.corners[0]].map(p => C.toLL(p, C.ORIGIN)); }
  return { hexes, edges };
};

// ---------- map restyle ----------
C.restyle = (map, p) => {
  for (const l of map.getStyle().layers) {
    const id = l.id, t = l.type;
    const set = (k, v) => { try { map.setPaintProperty(id, k, v); } catch (e) {} };
    const hide = () => map.setLayoutProperty(id, 'visibility', 'none');
    if (t === 'background') set('background-color', p.land);
    else if (t === 'symbol') {
      if (p.roadLabels && /highway-name-(major|minor)/.test(id)) { set('text-color', p.roadLabels); set('text-halo-color', p.land); }
      else hide();
    }
    else if (/boundary|aeroway|railway_service|ice|glacier/.test(id)) hide();
    else if (id === 'water') set('fill-color', p.water);
    else if (id === 'waterway') set('line-color', p.water);
    else if (id === 'park' || id === 'landcover_wood') { set('fill-color', p.park); set('fill-opacity', 1); }
    else if (id === 'landuse_residential') set('fill-color', p.land);
    else if (id === 'building') { set('fill-color', p.building); set('fill-outline-color', p.building); }
    else if (/railway/.test(id)) set('line-color', p.rail || p.road);
    else if (/casing/.test(id)) set('line-color', p.casing || p.road);
    else if (t === 'line') set('line-color', p.road);
    else if (t === 'fill') set('fill-color', p.land);
  }
};

C.newMap = (el, opts = {}) => new maplibregl.Map({
  container: el, style: C.STYLE, attributionControl: false, interactive: false,
  preserveDrawingBuffer: true, fadeDuration: 0, center: C.ORIGIN, zoom: 14.3, ...opts,
});

C.ready = (maps = []) => {
  const ps = maps.map(m => new Promise(r => {
    const done = () => { if (m.loaded() && m.areTilesLoaded()) r(); else m.once('idle', r); };
    m.once('idle', done);
  }));
  Promise.all([...ps, document.fonts.ready]).then(() => setTimeout(() => { document.title = 'ready'; }, 400));
};

C.statusBar = (dark) => `
<div class="sb" style="color:${dark ? '#fff' : '#000'}">
  <span class="sb-time">9:41</span>
  <span class="sb-right">
    <svg width="18" height="11" viewBox="0 0 18 11"><rect x="0" y="7" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="6" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="8.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="11" rx="1" fill="currentColor"/></svg>
    <svg width="16" height="11" viewBox="0 0 16 11"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 .6 10 10 0 0 0 .9 3.5L2 4.6a8.4 8.4 0 0 1 6-2.4Zm0 3.2c1.4 0 2.7.5 3.7 1.4l1.1-1.1A6.9 6.9 0 0 0 8 3.8c-1.8 0-3.5.7-4.8 1.9l1.1 1.1c1-.9 2.3-1.4 3.7-1.4Zm0 3.2c-.6 0-1.1.2-1.5.6L8 10.7l1.5-1.5c-.4-.4-.9-.6-1.5-.6Z" fill="currentColor"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4" fill="none"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity=".5"/></svg>
  </span>
</div>`;

C.markers = [];
// Hide markers that would sit under the floating search bar or hang off the sides.
C.cull = (map, minY, pad = 24, maxY = 1e9, maxX = 1e9) => {
  const W = Math.min(map.getContainer().clientWidth, maxX);
  for (const m of C.markers) {
    if (m.keep) continue;
    const p = map.project(m.getLngLat());
    if (p.y < minY || p.y > maxY || p.x < pad || p.x > W - pad) m.getElement().style.display = 'none';
  }
};
C.marker = (map, lngLat, html, anchor = 'center', cls = '') => {
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html;
  C.markers.push(new maplibregl.Marker({ element: el, anchor }).setLngLat(lngLat).addTo(map));
  return el;
};

C.claimed = () => C.areas.filter(a => !a.empty);
C.hasMsg = () => true;
window.C = C;
