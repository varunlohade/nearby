// Direction A — Night shift. Fake live data, MapLibre + HTML markers. No audio anywhere.
(() => {
  const SCREEN = document.body.dataset.screen || 'map';
  const MOBILE = innerWidth < 600;
  const q = new URLSearchParams(location.search);

  // ---------- seeded random so stills are repeatable ----------
  let seed = +(q.get('seed') || 7);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  // ---------- areas (Bengaluru) ----------
  const AREAS = [
    { id: 'indiranagar', name: 'Indiranagar', c: [77.6408, 12.9719], r: 1.25, busy: 0.8, here: 142, mine: true },
    { id: 'koramangala', name: 'Koramangala', c: [77.6230, 12.9345], r: 1.5, busy: 1.0, here: 213 },
    { id: 'hsr', name: 'HSR Layout', c: [77.6474, 12.9116], r: 1.3, busy: 0.55, here: 88 },
    { id: 'jayanagar', name: 'Jayanagar', c: [77.5838, 12.9285], r: 1.3, busy: 0.35, here: 61 },
    { id: 'whitefield', name: 'Whitefield', c: [77.7499, 12.9698], r: 1.9, busy: 0.6, here: 97 },
    { id: 'malleshwaram', name: 'Malleshwaram', c: [77.5709, 13.0035], r: 1.2, busy: 0.25, here: 44 },
  ];
  const byId = Object.fromEntries(AREAS.map((a) => [a.id, a]));
  const KM_LAT = 1 / 110.6, kmLng = (lat) => 1 / (111.3 * Math.cos((lat * Math.PI) / 180));

  // Ward-like polygons: 10 corners, radius jittered. Real build would load OSM boundaries.
  function wardPoly(c, r, s, n = 10) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2 + s;
      const k = r * (0.82 + 0.3 * Math.abs(Math.sin(s * 3.1 + i * 1.7)));
      pts.push([c[0] + Math.cos(t) * k * kmLng(c[1]), c[1] + Math.sin(t) * k * KM_LAT]);
    }
    pts.push(pts[0]);
    return pts;
  }
  const feats = AREAS.map((a, i) => ({ type: 'Feature', id: i, properties: { id: a.id, busy: a.busy, mine: a.mine ? 1 : 0 },
    geometry: { type: 'Polygon', coordinates: [wardPoly(a.c, a.r, i * 0.9 + 0.4)] } }));
  // a thin ring along each border, extruded into a "light wall" — taller when the area is busier
  const ringOf = (poly, c, km) => {
    const inner = poly.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; const d = Math.hypot(dx / kmLng(c[1]), dy / KM_LAT); const k = (d - km) / d; return [c[0] + dx * k, c[1] + dy * k]; });
    return [poly, inner.slice().reverse()];
  };
  const walls = AREAS.map((a, i) => ({ type: 'Feature', id: i, properties: { busy: a.busy, mine: a.mine ? 1 : 0 },
    geometry: { type: 'Polygon', coordinates: ringOf(feats[i].geometry.coordinates[0], a.c, 0.03) } }));
  const inArea = (a, spread = 0.55) => {
    const t = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * a.r * spread;
    return [a.c[0] + Math.cos(t) * d * kmLng(a.c[1]), a.c[1] + Math.sin(t) * d * KM_LAT];
  };

  // ---------- people (initials only, no photos) ----------
  const PEOPLE = [['Meera', '#7C5CDB'], ['Arjun', '#2F8F83'], ['Nisha', '#C2537A'], ['Kabir', '#3A78C9'], ['Rohan', '#9A6B2F'],
    ['Ananya', '#4E8B3A'], ['Farah', '#B5533C'], ['Dev', '#5B6478'], ['Ishaan', '#7A4FA0'], ['Tara', '#2E7D9B']];
  const av = (p, cls = 'av') => `<div class="${cls}" style="background:${p[1]}">${p[0][0]}</div>`;
  const stack = (n = 3, off = 0) => `<div class="stack">${PEOPLE.slice(off, off + n).map((p) => av(p)).join('')}</div>`;

  const CHATS = [
    ['Filter coffee at 12th Main, anyone?', 'indiranagar'], ['Lost a grey cat near Sony signal. Answers to Biscuit', 'koramangala'],
    ['Power is back on 5th Block', 'koramangala'], ['Who has a ladder I can borrow for an hour?', 'hsr'],
    ['Farmers market at the park is on till noon', 'jayanagar'], ['Traffic at ITPL is bad, leave early', 'whitefield'],
    ['Free jasmine saplings outside the temple', 'malleshwaram'], ['Badminton court free at 7, need a fourth', 'hsr'],
    ['The new bakery on 100 Feet Rd is worth it', 'indiranagar'], ['Water tanker coming to 27th Main at 4', 'hsr'],
  ];
  const EVENTS = [
    ['Board games night', 'Fri, 8 pm', 'koramangala'], ['Sunday run club', 'Sun, 6:30 am', 'koramangala'],
    ['Street clean-up', 'Sat, 7 am', 'indiranagar'], ['Kannada for beginners', 'Tue, 7 pm', 'jayanagar'],
    ['Lake walk', 'Sat, 6 am', 'whitefield'], ['Open mic', 'Thu, 8 pm', 'indiranagar'], ['Cycling to Nandi', 'Sun, 4 am', 'hsr'],
  ];

  // ---------- map ----------
  const CAM = MOBILE
    ? { center: [77.6300, 12.9500], zoom: 12.15, pitch: 55, bearing: -18, padding: { top: 70, bottom: 250, left: 0, right: 0 } }
    : { center: [77.6235, 12.9370], zoom: 13.35, pitch: 60, bearing: -18, padding: { left: 360, top: 0, right: 0, bottom: 0 } };
  if (SCREEN === 'chat') Object.assign(CAM, { center: [77.6300, 12.9455], zoom: 13.5, pitch: 60, bearing: -12, padding: { left: 360, right: 400, top: 0, bottom: 0 } });
  if (SCREEN === 'build') Object.assign(CAM, { center: [77.6620, 12.9340], zoom: 13.3 });
  const map = new maplibregl.Map({ container: 'map', style: window.MAP_STYLE, ...CAM, attributionControl: false,
    maxPitch: 70, fadeDuration: 0, antialias: true });
  window.__map = map;

  map.on('load', () => {
    const names = AREAS.map((a) => a.name).concat(['Koramangala', 'HSR Layout', 'Indiranagar', 'Bellandur', 'Bellanduru', 'Malleswaram', 'Malleshwara', 'Jayanagara', 'Koramangala 1st Block']);
    map.setFilter('label-place', ['all', map.getFilter('label-place'), ['!', ['in', ['coalesce', ['get', 'name:en'], ['get', 'name']], ['literal', names]]]]);
    map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
    const accent = '#FFB224';
    map.addLayer({ id: 'area-fill', type: 'fill', source: 'areas', paint: {
      'fill-color': ['case', ['==', ['get', 'mine'], 1], '#F3F4F6', accent],
      'fill-opacity': ['case', ['==', ['get', 'mine'], 1], 0.07,
        ['+', 0.03, ['*', ['get', 'busy'], 0.09], ['case', ['boolean', ['feature-state', 'hot'], false], 0.08, 0]]] } }, 'label-road');
    map.addLayer({ id: 'area-halo', type: 'line', source: 'areas', filter: ['==', ['get', 'mine'], 0], paint: {
      'line-color': accent, 'line-width': ['+', 4, ['*', ['get', 'busy'], 10]], 'line-blur': 8,
      'line-opacity': ['+', ['*', ['get', 'busy'], 0.22], ['case', ['boolean', ['feature-state', 'hot'], false], 0.3, 0]] } }, 'label-road');
    map.addLayer({ id: 'area-line', type: 'line', source: 'areas', paint: {
      'line-color': ['case', ['==', ['get', 'mine'], 1], '#F3F4F6', accent],
      'line-width': ['case', ['==', ['get', 'mine'], 1], 2, ['+', 1, ['*', ['get', 'busy'], 1.4]]],
      'line-opacity': ['case', ['==', ['get', 'mine'], 1], 0.9, ['+', 0.45, ['*', ['get', 'busy'], 0.5]]] } }, 'label-road');
    map.addLayer({ id: 'mine-dash', type: 'line', source: 'areas', filter: ['==', ['get', 'mine'], 1],
      paint: { 'line-color': '#F3F4F6', 'line-width': 6, 'line-opacity': 0.12 } }, 'buildings-3d');

    // build screen: the empty area I clicked, drawn as a dashed draft
    if (SCREEN === 'build') {
      const draft = { c: [77.6765, 12.9330], r: 1.05 };
      map.addSource('draft', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [wardPoly(draft.c, draft.r, 2.2, 9)] } } });
      map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', paint: { 'fill-color': accent, 'fill-opacity': 0.08 } }, 'label-road');
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': accent, 'line-width': 2, 'line-dasharray': [2, 1.5] } }, 'label-road');
      window.__draft = draft;
    }
    if (SCREEN === 'peek' || SCREEN === 'chat') map.setFeatureState({ source: 'areas', id: 1 }, { hot: true });

    map.addSource('walls', { type: 'geojson', data: { type: 'FeatureCollection', features: walls } });
    map.addLayer({ id: 'area-walls', type: 'fill-extrusion', source: 'walls', paint: {
      'fill-extrusion-color': ['case', ['==', ['get', 'mine'], 1], '#F3F4F6', accent],
      'fill-extrusion-height': ['case', ['==', ['get', 'mine'], 1], 50,
        ['+', ['*', ['get', 'busy'], 260], ['case', ['boolean', ['feature-state', 'hot'], false], 120, 0]]],
      'fill-extrusion-opacity': 0.55, 'fill-extrusion-vertical-gradient': false,
      'fill-extrusion-height-transition': { duration: 600, delay: 0 } } });
    labels();
    if (SCREEN === 'map' || SCREEN === 'peek' || SCREEN === 'build' || SCREEN === 'chat') ui();
    let go = false; const kick = () => { if (!go) { go = true; startLive(); } };
    map.once('idle', kick); setTimeout(kick, 2500);
  });

  // ---------- area name labels ----------
  function labels() {
    AREAS.forEach((a) => {
      const el = document.createElement('div');
      if (a.mine) {
        el.innerHTML = `<div class="youare">${ICON.area(16, '#060709')}You're in ${a.name}</div>`;
      } else {
        el.className = 'alabel' + (a.busy < 0.45 ? ' quiet' : '');
        el.innerHTML = `<b>${a.name}</b><span class="num">${a.here} here now</span>`;
      }
      new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(a.c).addTo(map);
    });
  }

  // ---------- icons ----------
  const ICON = {
    area: (s = 18, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"><path d="M4 7.5 10 4l7 2.5 3 6-2.5 6.5-7.5 1.5L4 16z"/></svg>`,
    chat: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`,
    cal: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>`,
    plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    minus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
    compass: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 16 20 12 16 8 20z"/></svg>`,
    pause: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,
    x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    lock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
    send: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
    clip: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/></svg>`,
    people: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>`,
  };
  const LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7.5 10 4l7 2.5 3 6-2.5 6.5-7.5 1.5L4 16z" fill="#FFB224"/></svg>`;

  // ---------- floating UI ----------
  const FEED0 = [
    ['ev', 'Board games night', 'Koramangala', 'Fri, 8 pm'],
    ['chat', 'Meera: Power is back on 5th Block', 'Koramangala', '2 min ago'],
    ['join', '3 people joined', 'HSR Layout', '4 min ago'],
    ['chat', 'Kabir: Traffic at ITPL is bad, leave early', 'Whitefield', '6 min ago'],
    ['ev', 'Street clean-up', 'Indiranagar', 'Sat, 7 am'],
  ];
  const rowHTML = (r, fresh) => {
    const ic = r[0] === 'ev' ? `<div class="ic ev">${ICON.cal}</div>` : r[0] === 'join' ? `<div class="ic">${ICON.people}</div>` : `<div class="ic">${ICON.chat}</div>`;
    return `<div class="row${fresh ? ' fresh' : ''}">${ic}<div class="tx"><p>${r[1]}</p><div class="meta"><span>${r[2]}</span><time>${r[3]}</time></div></div></div>`;
  };
  function ui() {
    const me = AREAS[0];
    const side = document.createElement('div');
    side.className = 'side';
    side.innerHTML = `
      <div class="card brand"><div class="wordmark">${LOGO}Circle</div><button class="me-btn" aria-label="Profile">VK</button></div>
      <div class="card feed"><div class="feed-head"><h2>What's happening</h2><small class="num">across 6 areas</small></div><div class="rows">${FEED0.map((r) => rowHTML(r)).join('')}</div></div>`;
    document.body.appendChild(side);

    const c = document.createElement('div');
    c.className = 'ctrls';
    c.innerHTML = `<div class="card grp"><button aria-label="Zoom in">${ICON.plus}</button><button aria-label="Zoom out">${ICON.minus}</button><button aria-label="Reset north">${ICON.compass}</button></div>
      <div class="card grp"><button aria-label="Pause live updates" id="pause">${ICON.pause}</button></div>`;
    document.body.appendChild(c);
    const at = document.createElement('div'); at.className = 'attrib'; at.textContent = '© OpenStreetMap, OpenFreeMap'; document.body.appendChild(at);
    document.getElementById('pause').onclick = () => { paused = !paused; };

    // mobile top + drawer
    const mt = document.createElement('div'); mt.className = 'mtop';
    mt.innerHTML = `<div class="wordmark">${LOGO}Circle</div><button class="me-btn" aria-label="Profile">VK</button>`;
    document.body.appendChild(mt);
    const dr = document.createElement('div'); dr.className = 'card drawer';
    dr.innerHTML = `<div class="grab"></div>
      <div class="feed-head" style="padding:4px 12px 4px"><h2>What's happening</h2><small>across 6 areas</small></div><div class="rows">${FEED0.slice(0, 3).map((r) => rowHTML(r)).join('')}</div>`;
    document.body.appendChild(dr);

    if (SCREEN === 'peek') peek();
    if (SCREEN === 'build') build();
    if (SCREEN === 'chat') chat();
  }

  function pushFeed(r) {
    document.querySelectorAll('.rows').forEach((box) => {
      const max = box.closest('.drawer') ? 3 : 5;
      const first = [...box.children].map((n) => n.getBoundingClientRect().top);
      box.insertAdjacentHTML('afterbegin', rowHTML(r, true));
      while (box.children.length > max) box.lastElementChild.remove();
      [...box.children].slice(1).forEach((n, i) => { // FLIP the older rows down
        const d = first[i] - n.getBoundingClientRect().top;
        n.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
      });
    });
  }

  // anchor a card to a map point, keep it on screen, aim the nub at the point
  function placeCard(el, p) {
    const h = el.offsetHeight, top = Math.max(20, Math.min(innerHeight - h - 20, p.y - h / 2));
    el.style.left = p.x + 'px'; el.style.top = top + 'px';
    el.querySelector('.nub').style.top = (p.y - top - 6) + 'px';
  }

  // ---------- peek ----------
  function peek() {
    const a = byId.koramangala;
    const el = document.createElement('div');
    el.className = 'card peek show';
    el.innerHTML = `<div class="nub"></div>
      <header><div><h3>${a.name}</h3><div class="sub num">${ICON.people}${a.here} people here now</div></div><button class="x" aria-label="Close">${ICON.x}</button></header>
      <div class="blk"><div class="lab">Latest post</div><div class="post">${av(PEOPLE[0])}<div><p><b>Meera</b> Power is back on 5th Block. The bakery on 80 Feet Rd is open again.</p><time>2 min ago</time></div></div></div>
      <div class="blk"><div class="lab">Next event</div><div class="ev"><div class="date"><small>Sun</small><b>23</b></div><div><b class="t">Sunday run club</b><span>6:30 am, Jyoti Nivas grounds</span><br><span class="num">34 going</span></div></div></div>
      <div class="blk people"><div><div class="lab" style="margin:0 0 2px">Who's around</div><b class="num">213 neighbours</b></div>${stack(5, 2)}</div>
      <button class="btn primary" style="margin-top:6px">Join Koramangala</button>`;
    document.body.appendChild(el);
    const place = () => placeCard(el, map.project([a.c[0] + 0.0128, a.c[1] + 0.0005]));
    place(); map.on('move', place);
    window.__block = [el];
  }

  // ---------- build ----------
  function build() {
    const el = document.createElement('div');
    el.className = 'card peek show';
    el.innerHTML = `<div class="nub"></div>
      <header><div><h3>Build your neighbourhood</h3><div class="sub">Nobody has started a circle here yet.</div></div><button class="x" aria-label="Close">${ICON.x}</button></header>
      <label class="field"><span>Name it</span><div class="input focus">Bellandur Lakeside<i class="caret"></i></div></label>
      <div class="founder"><div class="av">VK</div><p>You'll be the founder<br><span>Host events and invite people in.</span></p></div>
      <p class="note">${ICON.lock}Others only see the area name. Your exact spot never leaves your device.</p>
      <button class="btn primary">Build it</button>`;
    document.body.appendChild(el);
    const place = () => { const d = window.__draft; placeCard(el, map.project([d.c[0] + 0.0098, d.c[1] + 0.001])); };
    place(); map.on('move', place);
    window.__block = [el];
  }

  // ---------- chat ----------
  function chat() {
    document.querySelector('.ctrls').style.transform = 'translateX(-400px)';
    document.querySelector('.attrib').style.right = '472px';
    const d = document.createElement('aside');
    d.className = 'dock';
    d.innerHTML = `<header><div class="shape">${ICON.area(20, '#1A1205')}</div><div><h3>Koramangala</h3><div class="sub num">213 here now, 1,904 members</div></div><div class="sp"></div>${stack(3, 4)}<button class="x" aria-label="Close chat">${ICON.x}</button></header>
      <div class="msgs">
        <div class="day">Today</div>
        <div class="m">${av(PEOPLE[8])}<div class="b"><div class="n">Ishaan</div><p>Is the Sony signal flyover open again?</p></div><time>3:51</time></div>
        <div class="m">${av(PEOPLE[5])}<div class="b"><div class="n">Ananya</div><p>Yes, both lanes since this morning.</p></div><time>3:55</time></div>
        <div class="m">${av(PEOPLE[0])}<div class="b"><div class="n">Meera</div><p>Power is back on 5th Block. The bakery on 80 Feet Rd is open again.</p></div><time>4:02</time></div>
        <div class="m">${av(PEOPLE[1])}<div class="b"><div class="n">Arjun</div><p>Anyone want to split a cab to the airport at 6?</p></div><time>4:10</time></div>
        <div><p class="hosted">Nisha posted an event</p>
        <div class="m" style="max-width:100%">${av(PEOPLE[2])}<div class="evcard"><div class="top"><div class="date"><small>Sun</small><b>23</b></div><div><b class="t">Sunday run club</b><span>6:30 am, Jyoti Nivas College grounds</span><span>5 km easy pace, all levels</span></div></div>
          <div class="bot">${stack(3, 5)}<small class="num">34 going</small><button class="go">I'm going</button></div></div></div></div>
        <div class="m">${av(PEOPLE[3])}<div class="b"><div class="n">Kabir</div><p>Count me in. First timers welcome?</p></div><time>4:21</time></div>
        <div class="m mine"><time>4:23</time><div class="b"><p>Just joined! I'll bring two friends from 4th Block.</p></div></div>
      </div>
      <div class="typing">Rohan is typing</div>
      <div class="composer"><button class="x" style="width:44px;height:44px;border-radius:11px" aria-label="Attach">${ICON.clip}</button><div class="input">Message Koramangala</div><button class="send" aria-label="Send">${ICON.send}</button></div>`;
    document.body.appendChild(d);
    window.__block = [d];
  }

  // ---------- live pop-ups ----------
  let paused = false, live = 0;
  const STILL = q.has('still');
  if (STILL) document.body.classList.add('still');
  const usedTxt = new Set(['Power is back on 5th Block', 'Traffic at ITPL is bad, leave early', 'Board games night', 'Street clean-up']);
  // pop-ups need a free screen rectangle: not under a panel, a label or another pop-up
  const R = (l, t, r, b) => ({ l, t, r, b });
  const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const popRect = (p, kind = 'chat') => kind === 'event' ? R(p.x - 90, p.y - 84, p.x + 90, p.y + 6)
    : kind === 'join' ? (MOBILE ? R(p.x - 115, p.y - 70, p.x + 115, p.y + 40) : R(p.x - 150, p.y - 76, p.x + 150, p.y + 64))
    : MOBILE ? R(p.x - 50, p.y - 84, p.x + 170, p.y + 6) : R(p.x - 30, p.y - 90, p.x + 232, p.y + 8);
  const panels = () => [...document.querySelectorAll('.side, .ctrls, .mtop, .drawer, .peek, .dock')].map((e) => {
    const r = e.getBoundingClientRect(); return R(r.left - 12, r.top - 12, r.right + 12, r.bottom + 12); });
  const labelRects = () => AREAS.map((a) => { const c = map.project(a.c); return R(c.x - 90, c.y - 44, c.x + 90, c.y + 4); });
  const blocked = (p, k) => panels().some((r) => hit(popRect(p, k), r));
  const visible = (p, k) => { const r = popRect(p, k); return r.l > 8 && r.r < innerWidth - 8 && r.t > 8 && p.y < innerHeight - 24; };
  const spots = [];
  const occupied = (p, k) => spots.some((s) => hit(popRect(p, k), s)) || labelRects().some((r) => hit(popRect(p, k), r));
  function onScreenAreas() {
    return AREAS.filter((a) => { const p = map.project(a.c); return p.x > 0 && p.x < innerWidth && p.y > 0 && p.y < innerHeight; });
  }
  function spot(kind) {
    for (let i = 0; i < 90; i++) {
      const list = onScreenAreas();
      const a = pick(list.length ? list : AREAS);
      const ll = inArea(a, 0.85);
      const p = map.project(ll);
      if (visible(p, kind) && !blocked(p, kind) && !occupied(p, kind)) return { a, ll, p, kind };
    }
    return null;
  }

  function addPop(kind, html, ll, p, life = 4200) {
    if (STILL) life = 600000;
    const el = document.createElement('div');
    el.className = 'pop' + (kind === 'event' ? ' drop' : '');
    el.innerHTML = `<div class="in">${html}</div>`;
    const m = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: kind === 'chat' ? [MOBILE ? 60 : 100, 0] : [0, 0] }).setLngLat(ll).addTo(map);
    const s = popRect(p, kind); spots.push(s); live++;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => { el.classList.add('out'); }, life);
    setTimeout(() => { m.remove(); spots.splice(spots.indexOf(s), 1); live--; }, life + 450);
  }

  function popChat() {
    const s = spot('chat'); if (!s) return;
    const pool = CHATS.filter((c) => c[1] === s.a.id);
    let fresh = (pool.length ? pool : CHATS).filter((c) => !usedTxt.has(c[0]));
    if (!fresh.length) { usedTxt.clear(); fresh = pool.length ? pool : CHATS; }
    const [text] = pick(fresh); usedTxt.add(text);
    const who = pick(PEOPLE);
    addPop('chat', `<div class="bubble">${av(who)}<div><p>${text}</p><small>${who[0]} in ${s.a.name}</small></div></div>`, s.ll, s.p);
    pushFeed(['chat', `${who[0]}: ${text}`, s.a.name, 'just now']);
  }
  function popEvent() {
    const s = spot('event'); if (!s) return;
    const pool = EVENTS.filter((c) => c[2] === s.a.id);
    let fresh = (pool.length ? pool : EVENTS).filter((c) => !usedTxt.has(c[0]));
    if (!fresh.length) fresh = EVENTS.filter((c) => !usedTxt.has(c[0]));
    const [title, when] = pick(fresh.length ? fresh : EVENTS); usedTxt.add(title);
    addPop('event', `<div class="pin"><div class="tag"><b>${title}</b><span>${when}</span></div><div class="stem"></div><div class="foot"></div></div>`, s.ll, s.p, 4800);
    pushFeed(['ev', title, s.a.name, when]);
  }
  function popJoin() {
    const s = spot('join'); if (!s) return;
    const n = 2 + Math.floor(rnd() * 5);
    const fid = AREAS.indexOf(s.a);
    map.setFeatureState({ source: 'areas', id: fid }, { hot: true });
    setTimeout(() => { if (!(SCREEN !== 'map' && fid === 1)) map.setFeatureState({ source: 'areas', id: fid }, { hot: false }); }, 2600);
    const off = Math.floor(rnd() * 6);
    addPop('join', `<div class="ripple"><i></i><i></i><i></i></div><div class="joined">${stack(3, off)}<span><b class="num">${n} people</b> joined ${s.a.name}</span></div>`, s.ll, s.p, 3600);
    pushFeed(['join', `${n} people joined`, s.a.name, 'just now']);
  }
  const KINDS = [popChat, popEvent, popJoin, popChat];
  function tick() {
    if (!paused && live < (MOBILE ? 3 : 5)) pick(KINDS)();
    setTimeout(tick, 1000 + rnd() * 1600);
  }
  window.__A = { spot: (...a) => spot(...a), popChat: () => popChat(), popJoin: () => popJoin(), started: false };
  function startLive() { window.__A.started = true;
    if (STILL) { const n = +(q.get('n') || 4); const k = [popJoin, popChat, popEvent, popChat, popEvent];
      for (let i = 0; i < n; i++) setTimeout(k[i], i * 260); return; }
    setTimeout(tick, 300);
  }
})();
