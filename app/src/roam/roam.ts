// Free Roam: an open-world sandbox of the visitor's real neighbourhood.
// Drive, walk or fly a drone through streets and buildings read from the map,
// find places (activities, rooms, events, live audio, parks), follow a GPS
// route or jump there, and hear live audio venues when you get close.

import * as THREE from 'three';
import type maplibregl from 'maplibre-gl';
import './roam.css';
import { AudioSession } from '../create/audio';
import type { Activity, Place } from '../world/earth';
import { extractWorld, Frame, type WorldData, type XZ } from './data';
import { RoadGraph } from './graph';
import { buildAreas, buildBuildings, buildGround, buildRoads, COLORS, makeBeacon, makeCar, makeRoute, makeSparks, makeTraffic, makeWalker } from './build';

export interface RoamOptions {
  map: maplibregl.Map;
  place?: Place;
  activities: Activity[];
  user: { name: string };
  onExit?: () => void;
}

type Mode = 'car' | 'walk' | 'drone';
interface Spot {
  id: string; name: string; kind: string; x: number; z: number; color: number;
  live?: number; listening?: number; detail?: string;
  beacon?: ReturnType<typeof makeBeacon>; label?: HTMLElement;
}
interface TrafficCar {
  edge: number; from: number; t: number; speed: number; cruise: number; color: THREE.Color;
  x: number; z: number; h: number; shown: number;
  bumped: number; vx: number; vz: number; spin: number;
}

const RADIUS = 900;
const LISTEN_RADIUS = 60;
const KIND_COLOR: Record<string, number> = {
  activity: 0xf5bd52, event: 0xf5bd52, room: 0x75c4ee, audio: 0xf495ae, community: 0x9dc48c,
  park: 0x7fbf8a, landmark: 0xe8dcc1,
};
const KIND_LABEL: Record<string, string> = {
  activity: 'Activity', event: 'Event', room: 'Chat room', audio: 'Live audio', community: 'Community', park: 'Park', landmark: 'Landmark',
};
// Countries that drive on the left, so traffic keeps to the correct side.
const LEFT_HAND = /India|United Kingdom|Ireland|Japan|Australia|New Zealand|South Africa|Singapore|Malaysia|Indonesia|Thailand|Sri Lanka|Pakistan|Bangladesh|Nepal|Kenya|Hong Kong|Cyprus|Malta|Jamaica/i;

const esc = (s: string) => s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmtDist = (m: number) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km');

let active: Roam | undefined;

/** Open Free Roam. Resolves once the world is ready (or failed to load). */
export async function openRoam(options: RoamOptions) {
  if (active) return;
  active = new Roam(options);
  await active.start();
}

class Roam {
  private root = document.createElement('div');
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 2600);
  private frame!: Frame;
  private world!: WorldData;
  private graph!: RoadGraph;
  private segments = new Float32Array();
  private segGrid = new Map<number, number[]>();
  private names: { name: string; ax: number; az: number; bx: number; bz: number }[] = [];
  private nameGrid = new Map<number, number[]>();
  private spots: Spot[] = [];
  private savedCamera?: maplibregl.CameraOptions;
  private raf = 0;
  private disposed = false;
  private touch = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  private driveLeft = false;

  // Player.
  private mode: Mode = 'car';
  private car = { x: 0, z: 0, h: 0, vx: 0, vz: 0, steer: 0, mesh: makeCar(COLORS.accent) };
  private walker = { x: 0, z: 0, h: 0, mesh: makeWalker(), step: 0 };
  private drone = { x: 0, z: 0, h: 0, alt: 70 };
  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private touchButtons = new Set<string>();
  private lastHit = 0;
  private stuck = 0;
  private shake = 0;

  // World objects.
  private traffic: TrafficCar[] = [];
  private trafficMesh!: ReturnType<typeof makeTraffic>;
  private sparks = makeSparks();
  private sparkLife: { vx: number; vy: number; vz: number; life: number }[] = [];
  private beaconTime = 0;
  private route?: { mesh: THREE.Mesh; points: XZ[]; target: Spot | { name: string; x: number; z: number }; checked: number };

  // Camera smoothing.
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  // Audio venues.
  private audio?: { id: string; session: AudioSession; speaking: boolean };
  private muteUntilOutside = new Set<string>();
  private joining = false;

  // HUD.
  private minimap!: HTMLCanvasElement;
  private roadsImage!: HTMLCanvasElement;
  private readonly mapScale = 0.75; // px per metre in the pre-rendered road image
  private fpsFrames: number[] = [];
  private nextTick = 0;
  private timers: number[] = [];

  constructor(private options: RoamOptions) {}

  // ---------------------------------------------------------------- lifecycle
  async start() {
    this.mountShell();
    try {
      await this.loadWorld();
    } catch (error) {
      console.error('[roam]', error);
      this.root.querySelector('.roam-loading p')!.textContent = 'Street data did not load. Try again in a moment.';
      return;
    }
    this.buildScene();
    await this.loadSpots();
    this.spawn();
    this.root.querySelector('.roam-loading')!.remove();
    if (localStorage.getItem('nearby.roam.onboarded') !== '1') this.onboarding(true);
    this.timers.push(window.setInterval(() => void this.loadSpots(true), 15000));
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private exit = () => {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.timers.forEach(clearInterval);
    this.audio?.session.leave();
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('keyup', this.onKey, true);
    removeEventListener('resize', this.onResize);
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach(m => m.dispose());
    });
    this.renderer?.dispose();
    this.root.remove();
    document.body.classList.remove('roam-open');
    if (this.savedCamera) this.options.map.jumpTo(this.savedCamera);
    active = undefined;
    this.options.onExit?.();
  };

  private mountShell() {
    document.body.classList.add('roam-open');
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.root.className = 'roam' + (this.touch ? ' is-touch' : '');
    this.root.innerHTML = `
      <canvas class="roam-canvas"></canvas>
      <div class="roam-labels"></div>
      <div class="roam-flash"></div>
      <header class="roam-top">
        <button type="button" class="roam-exit" title="Back to the map (Esc)">← Map</button>
        <div class="roam-title"><span>Free roam</span><b>${esc(this.options.place?.locality ?? 'Your area')}</b></div>
        <div class="roam-modes" role="group" aria-label="How to explore">
          <button type="button" data-mode="car" aria-pressed="true">Car</button><button type="button" data-mode="walk">Walk</button><button type="button" data-mode="drone">Drone</button>
        </div>
        <button type="button" class="roam-places-btn">Places</button>
        <button type="button" class="roam-help" aria-label="Controls">?</button>
      </header>
      <div class="roam-street"><span></span></div>
      <div class="roam-dest" hidden><i></i><span class="roam-dest-text"></span><button type="button" data-act="jump">Jump there</button><button type="button" data-act="clear" aria-label="Clear route">×</button></div>
      <div class="roam-toast" role="status"></div>
      <div class="roam-mini"><canvas width="200" height="200" aria-label="Mini-map: tap to set a route"></canvas><button type="button" class="roam-mini-big">Map</button></div>
      <div class="roam-speed"><b>0</b><small>km/h</small><i><s></s></i></div>
      <aside class="roam-places" hidden><header><b>Places nearby</b><button type="button" aria-label="Close">×</button></header><ol></ol></aside>
      <div class="roam-bigmap" hidden><canvas></canvas><p>Tap anywhere to get a route there</p><button type="button">Close</button></div>
      <section class="roam-live" hidden></section>
      <div class="roam-touch" ${this.touch ? '' : 'hidden'}>
        <div class="roam-stick"><i></i></div>
        <div class="roam-touch-buttons">
          <button type="button" data-touch="up" class="drone-only">▲</button>
          <button type="button" data-touch="down" class="drone-only">▼</button>
          <button type="button" data-touch="drift" class="car-only">Drift</button>
          <button type="button" data-touch="reset">Reset</button>
        </div>
      </div>
      <div class="roam-loading"><b>Building your neighbourhood…</b><p>Reading streets and buildings from the map</p></div>
      <div class="roam-onboard" hidden></div>`;
    document.body.append(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    q('.roam-exit').onclick = this.exit;
    q('.roam-help').onclick = () => this.onboarding(true);
    q('.roam-places-btn').onclick = () => this.togglePlaces();
    q('.roam-places header button').onclick = () => this.togglePlaces(false);
    q('.roam-mini-big').onclick = () => this.toggleBigMap(true);
    q('.roam-bigmap button').onclick = () => this.toggleBigMap(false);
    q('.roam-dest [data-act=clear]').onclick = () => this.clearRoute();
    q('.roam-dest [data-act=jump]').onclick = () => { if (this.route) this.jumpTo(this.route.target); };
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => { b.onclick = () => this.setMode(b.dataset.mode as Mode); });
    this.minimap = q('.roam-mini canvas');
    this.minimap.onclick = e => this.onMapClick(this.minimap, e, false);
    q<HTMLCanvasElement>('.roam-bigmap canvas').onclick = e => this.onMapClick(q('.roam-bigmap canvas'), e, true);
    addEventListener('keydown', this.onKey, true);
    addEventListener('keyup', this.onKey, true);
    addEventListener('resize', this.onResize);
    this.mountTouch();
  }

  private async loadWorld() {
    const map = this.options.map, place = this.options.place;
    const center = place ? { lng: place.lng, lat: place.lat } : map.getCenter();
    this.driveLeft = LEFT_HAND.test(place?.country ?? '');
    this.savedCamera = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    // Make sure the vector tiles around the area are loaded (z14 holds buildings).
    map.jumpTo({ center: [center.lng, center.lat], zoom: 14.2, bearing: 0, pitch: 0 });
    await Promise.race([new Promise(resolve => map.once('idle', resolve)), new Promise(resolve => setTimeout(resolve, 9000))]);
    this.frame = new Frame(center.lng, center.lat);
    this.world = extractWorld(map, this.frame, RADIUS);
    if (!this.world.roads.some(r => r.drivable)) throw new Error('No roads');
    this.graph = new RoadGraph(this.world.roads);
  }

  // ---------------------------------------------------------------- scene
  private buildScene() {
    const canvas = this.root.querySelector<HTMLCanvasElement>('.roam-canvas')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.touch, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.touch ? 1.5 : 1.75));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 140, 720);
    this.scene.add(new THREE.HemisphereLight(0xc9d3e6, 0x202326, 1.45));
    const sun = new THREE.DirectionalLight(0xffe2bd, 1.1); sun.position.set(-300, 420, 200); this.scene.add(sun);

    this.scene.add(buildGround(RADIUS), buildAreas(this.world.areas), buildRoads(this.world.roads));
    const { mesh, segments } = buildBuildings(this.world.buildings);
    this.scene.add(mesh);
    this.segments = segments;
    for (let i = 0; i < segments.length; i += 4) {
      const ax = segments[i], az = segments[i + 1], bx = segments[i + 2], bz = segments[i + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
      const cells = new Set<number>();
      for (let s = 0; s <= steps; s++) cells.add(this.cellKey(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps, 16));
      for (const c of cells) (this.segGrid.get(c) ?? this.segGrid.set(c, []).get(c)!).push(i);
    }
    for (const line of this.world.names) for (let i = 1; i < line.pts.length; i++) {
      const [ax, az] = line.pts[i - 1], [bx, bz] = line.pts[i];
      const k = this.names.push({ name: line.name, ax, az, bx, bz }) - 1;
      for (let s = 0; s <= 4; s++) {
        const c = this.cellKey(ax + (bx - ax) * s / 4, az + (bz - az) * s / 4, 30);
        (this.nameGrid.get(c) ?? this.nameGrid.set(c, []).get(c)!).push(k);
      }
    }

    this.scene.add(this.car.mesh, this.walker.mesh, this.sparks);
    this.walker.mesh.visible = false;
    const count = this.touch ? 14 : 30;
    this.trafficMesh = makeTraffic(count);
    this.scene.add(this.trafficMesh.body, this.trafficMesh.cabin, this.trafficMesh.lights);
    const palette = [0xd46b59, 0x82abb9, 0xc8c6ba, 0x8994b7, 0x6f8f72, 0xb88a5e, 0x9b6f8e, 0xe0e0d8];
    for (let i = 0; i < count; i++) {
      const color = new THREE.Color(palette[i % palette.length]);
      this.trafficMesh.body.setColorAt(i, color);
      this.traffic.push({ edge: 0, from: 0, t: 0, speed: 0, cruise: 10, color, x: 0, z: 0, h: 0, shown: 0, bumped: 0, vx: 0, vz: 0, spin: 0 });
    }
    this.renderRoadsImage();
    (window as unknown as { __roamStats: unknown }).__roamStats = this.stats = {
      buildings: this.world.buildings.length, roads: this.world.roads.length, nodes: this.graph.nodes.length, traffic: count, fps: 0,
      hits: 0, trafficHits: 0, volume: -1, distance: -1, mode: 'car', speed: 0,
    };
    // Test hooks, only with ?roamdebug in the URL.
    if (new URLSearchParams(location.search).has('roamdebug')) (window as unknown as { __roam: unknown }).__roam = {
      aimAtBuilding: () => this.debugAimAtBuilding(), aimAtTraffic: () => this.debugAimAtTraffic(),
      teleport: (x: number, z: number) => { this.drone.x = this.walker.x = x; this.drone.z = this.walker.z = z; this.resetCar(x, z); this.snapCamera(); },
      spots: () => this.spots.map(sp => ({ id: sp.id, name: sp.name, kind: sp.kind, x: sp.x, z: sp.z, live: sp.live })),
      position: () => this.position(),
    };
  }

  private stats: Record<string, number | string> = {};

  private debugAimAtBuilding() {
    const s = this.segments;
    let best = -1, bd = Infinity;
    for (let i = 0; i < s.length; i += 4) {
      const len = Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]);
      if (len < 8) continue;
      const mx = (s[i] + s[i + 2]) / 2, mz = (s[i + 1] + s[i + 3]) / 2, d = Math.hypot(mx - this.car.x, mz - this.car.z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    const mx = (s[best] + s[best + 2]) / 2, mz = (s[best + 1] + s[best + 3]) / 2;
    let nx = -(s[best + 3] - s[best + 1]), nz = s[best + 2] - s[best];
    const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    for (const sign of [1, -1]) {
      const x = mx + nx * sign * 16, z = mz + nz * sign * 16;
      if (this.pushOut(x, z, 1.2)) continue;
      Object.assign(this.car, { x, z, h: Math.atan2(mx - x, -(mz - z)), vx: 0, vz: 0, steer: 0 });
      this.snapCamera();
      return true;
    }
    return false;
  }

  private debugAimAtTraffic() {
    const t = this.traffic[0];
    t.bumped = 0; t.cruise = 0; t.speed = 0;
    this.trafficPose(t);
    const fx = Math.sin(t.h), fz = -Math.cos(t.h);
    Object.assign(this.car, { x: t.x - fx * 18, z: t.z - fz * 18, h: t.h, vx: 0, vz: 0, steer: 0 });
    this.snapCamera();
    return true;
  }

  private cellKey(x: number, z: number, size: number) { return (Math.floor(x / size) + 4096) * 8192 + (Math.floor(z / size) + 4096); }

  // ---------------------------------------------------------------- places
  private async loadSpots(refresh = false) {
    const keep = new Map(this.spots.map(s => [s.id, s]));
    const next: Spot[] = [];
    const add = (s: Spot) => {
      if (Math.hypot(s.x, s.z) > RADIUS - 10) return;
      const old = keep.get(s.id);
      if (old) { Object.assign(old, { live: s.live, listening: s.listening, name: s.name, detail: s.detail }); next.push(old); }
      else next.push(s);
    };
    const place = this.options.place;
    // Things people created on the map (rooms, events, live audio, communities) come first:
    // they carry their real kind and live counts. The app also lists them as activities.
    const created = new Set<string>();
    try {
      const [w, n] = this.frame.toLngLat(-RADIUS, -RADIUS), [e, s] = this.frame.toLngLat(RADIUS, RADIUS);
      const res = await fetch(`/api/places?bbox=${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`);
      const data = await res.json() as { items?: { id: string; kind: string; title: string; lat: number; lng: number; live?: number; listening?: number; place?: string }[] };
      for (const item of data.items ?? []) {
        created.add(item.id);
        const [x, z] = this.frame.toLocal(item.lng, item.lat);
        add({ id: 'c:' + item.id, name: item.title, kind: item.kind, x, z, color: KIND_COLOR[item.kind] ?? KIND_COLOR.community,
          live: item.live, listening: item.listening, detail: item.place });
      }
    } catch { /* created places are optional */ }
    for (const a of this.options.activities) {
      if (created.has(a.id)) continue;
      const at = a.venuePoint ?? (place ? [place.lng + a.x / (111.32 * Math.cos(place.lat * Math.PI / 180)), place.lat - a.z / 111.32] : null);
      if (!at) continue;
      const [x, z] = this.frame.toLocal(at[0], at[1]);
      add({ id: 'a:' + a.id, name: a.title, kind: 'activity', x, z, color: KIND_COLOR.activity, detail: a.time });
    }
    for (const l of this.world.landmarks) add({ id: 'l:' + l.name, name: l.name, kind: l.kind === 'park' ? 'park' : 'landmark', x: l.x, z: l.z, color: KIND_COLOR[l.kind === 'park' ? 'park' : 'landmark'] });
    // Remove what disappeared.
    for (const old of this.spots) if (!next.includes(old)) { old.label?.remove(); if (old.beacon) this.scene.remove(old.beacon.group); }
    this.spots = next;
    for (const s of this.spots) {
      if (!s.beacon && s.kind !== 'landmark') {
        s.beacon = makeBeacon(s.color, s.kind === 'audio' ? 90 : s.kind === 'park' ? 30 : 60);
        s.beacon.group.position.set(s.x, 0, s.z);
        this.scene.add(s.beacon.group);
      }
      if (!s.label) {
        const label = document.createElement('button');
        label.type = 'button';
        s.label = label;
        s.label.className = 'roam-label kind-' + s.kind;
        s.label.onclick = () => this.setRoute(s);
        this.root.querySelector('.roam-labels')!.append(s.label);
      }
      const live = s.kind === 'audio' ? `<em>${s.live ?? 0} live${s.listening ? ` · ${s.listening} listening` : ''}</em>` : '';
      s.label.innerHTML = `<span>${esc(KIND_LABEL[s.kind] ?? s.kind)}</span><b>${esc(s.name)}</b>${live}<small></small>`;
    }
    if (refresh) this.renderPlaces();
  }

  private togglePlaces(open?: boolean) {
    const panel = this.root.querySelector<HTMLElement>('.roam-places')!;
    panel.hidden = !(open ?? panel.hidden);
    if (!panel.hidden) this.renderPlaces();
  }

  private renderPlaces() {
    const panel = this.root.querySelector<HTMLElement>('.roam-places')!;
    if (panel.hidden) return;
    const [px, pz] = this.position();
    const list = [...this.spots].sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz)).slice(0, 30);
    const ol = panel.querySelector('ol')!;
    ol.innerHTML = list.map((s, i) => `<li class="kind-${s.kind}"><i></i><span><b>${esc(s.name)}</b><small>${esc(KIND_LABEL[s.kind] ?? s.kind)}${s.kind === 'audio' ? ` · ${s.live ?? 0} live` : ''} · ${fmtDist(Math.hypot(s.x - px, s.z - pz))}</small></span>
      <button type="button" data-i="${i}" data-act="route">Route</button><button type="button" data-i="${i}" data-act="jump">Jump</button></li>`).join('')
      || '<li class="empty">Nothing pinned here yet. Explore the streets, or create something from the map.</li>';
    ol.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.onclick = () => { const s = list[Number(b.dataset.i)]; this.togglePlaces(false); if (b.dataset.act === 'jump') this.jumpTo(s); else this.setRoute(s); };
    });
  }

  // ---------------------------------------------------------------- spawning and modes
  private spawn() {
    // Start near the most interesting spot: the activity or venue closest to the area centre.
    const pick = [...this.spots].filter(s => s.kind !== 'landmark').sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    const target: XZ = pick && Math.hypot(pick.x, pick.z) < 700 ? [pick.x, pick.z] : [0, 0];
    const start = this.graph.spawnNear(target[0], target[1]) ?? { point: target, heading: 0 };
    Object.assign(this.car, { x: start.point[0], z: start.point[1], h: start.heading, vx: 0, vz: 0, steer: 0 });
    this.placeTraffic(true);
    this.snapCamera();
  }

  private setMode(mode: Mode) {
    if (mode === this.mode) return;
    const [x, z] = this.position();
    if (mode === 'car') {
      // Get back in if the car is close, otherwise bring it to the nearest road.
      if (Math.hypot(this.car.x - x, this.car.z - z) > 10) this.resetCar(x, z);
    } else if (mode === 'walk') {
      const h = this.mode === 'car' ? this.car.h : this.drone.h;
      if (this.mode === 'car') { this.walker.x = this.car.x + Math.cos(this.car.h) * 2.6; this.walker.z = this.car.z + Math.sin(this.car.h) * 2.6; }
      else { const hit = this.graph.nearest(x, z, 200); [this.walker.x, this.walker.z] = hit ? hit.point : [x, z]; }
      this.walker.h = h;
    } else {
      this.drone.x = x; this.drone.z = z; this.drone.h = this.mode === 'car' ? this.car.h : this.walker.h; this.drone.alt = 70;
    }
    this.mode = mode;
    this.walker.mesh.visible = mode === 'walk';
    this.root.classList.toggle('mode-drone', mode === 'drone');
    this.root.classList.toggle('mode-walk', mode === 'walk');
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    this.toast(mode === 'car' ? 'Driving' : mode === 'walk' ? 'On foot: walk anywhere, even through parks' : 'Drone: fly over the neighbourhood');
    this.snapCamera();
  }

  private position(): XZ {
    return this.mode === 'car' ? [this.car.x, this.car.z] : this.mode === 'walk' ? [this.walker.x, this.walker.z] : [this.drone.x, this.drone.z];
  }
  private heading() { return this.mode === 'car' ? this.car.h : this.mode === 'walk' ? this.walker.h : this.drone.h; }

  private resetCar(x = this.car.x, z = this.car.z) {
    const spot = this.graph.spawnNear(x, z);
    if (!spot) return;
    Object.assign(this.car, { x: spot.point[0], z: spot.point[1], h: spot.heading, vx: 0, vz: 0, steer: 0 });
    this.stuck = 0;
  }

  /** Fast travel: appear on the road next to a place. */
  private jumpTo(target: { x: number; z: number; name: string }) {
    this.flash(0.9);
    const road = this.graph.nearest(target.x, target.z, 150);
    const [x, z] = road ? road.point : [target.x, target.z];
    if (this.mode === 'car') this.resetCar(x, z);
    else if (this.mode === 'walk') { this.walker.x = x; this.walker.z = z; }
    else { this.drone.x = target.x; this.drone.z = target.z; }
    this.clearRoute();
    this.snapCamera();
    this.toast('Arrived at ' + target.name);
  }

  // ---------------------------------------------------------------- GPS route
  private setRoute(target: Spot | { name: string; x: number; z: number }) {
    this.clearRoute();
    const points = this.graph.route(this.position(), [target.x, target.z]);
    if (!points || points.length < 2) { this.toast('No road route there. Use “Jump there”.'); this.showDest(target, null); return; }
    points.push([target.x, target.z]);
    const mesh = makeRoute(points);
    this.scene.add(mesh);
    this.route = { mesh, points, target, checked: performance.now() };
    this.showDest(target, points);
  }

  private showDest(target: { name: string }, points: XZ[] | null) {
    const chip = this.root.querySelector<HTMLElement>('.roam-dest')!;
    chip.hidden = false;
    chip.dataset.name = target.name;
    if (!points) this.route = undefined;
    this.updateDest();
  }

  private updateDest() {
    const chip = this.root.querySelector<HTMLElement>('.roam-dest')!;
    if (chip.hidden) return;
    const left = this.route ? this.routeRemaining() : null;
    chip.querySelector('.roam-dest-text')!.textContent = (chip.dataset.name ?? '') + (left !== null ? ' · ' + fmtDist(left) : '');
  }

  private routeRemaining() {
    if (!this.route) return 0;
    const [px, pz] = this.position(), pts = this.route.points;
    let best = Infinity, bestI = 0, bestT = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const t = clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1);
      const d = Math.hypot(px - ax - vx * t, pz - az - vz * t);
      if (d < best) { best = d; bestI = i; bestT = t; }
    }
    let left = Math.hypot(pts[bestI][0] - pts[bestI - 1][0], pts[bestI][1] - pts[bestI - 1][1]) * (1 - bestT);
    for (let i = bestI + 1; i < pts.length; i++) left += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    // Off the route for a while: plan again from here.
    if (best > 40 && performance.now() - this.route.checked > 1500) { const target = this.route.target; this.route.checked = performance.now(); setTimeout(() => this.setRoute(target)); }
    return left;
  }

  private clearRoute() {
    if (this.route) { this.scene.remove(this.route.mesh); this.route.mesh.geometry.dispose(); (this.route.mesh.material as THREE.Material).dispose(); }
    this.route = undefined;
    this.root.querySelector<HTMLElement>('.roam-dest')!.hidden = true;
  }

  // ---------------------------------------------------------------- input
  private onKey = (e: KeyboardEvent) => {
    if (this.disposed || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = ['w', 'a', 's', 'd', 'q', 'e', ' ', 'Shift', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'r', 'Escape', 'm', 'g', 'v', '1', '2', '3', 'c'].includes(k);
    if (!handled) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'keyup') { this.keys.delete(k); return; }
    if (e.repeat && !['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return;
    this.keys.add(k);
    const onboard = this.root.querySelector<HTMLElement>('.roam-onboard')!;
    if (!onboard.hidden && (k === 'Escape' || k === ' ')) { this.onboarding(false); return; }
    if (k === 'Escape') {
      const big = this.root.querySelector<HTMLElement>('.roam-bigmap')!, places = this.root.querySelector<HTMLElement>('.roam-places')!;
      if (!big.hidden) this.toggleBigMap(false); else if (!places.hidden) this.togglePlaces(false); else this.exit();
    } else if (k === 'r') { if (this.mode === 'car') { this.resetCar(); this.toast('Back on the road'); } }
    else if (k === 'm') this.toggleBigMap();
    else if (k === 'g') this.togglePlaces();
    else if (k === '1') this.setMode('car');
    else if (k === '2') this.setMode('walk');
    else if (k === '3') this.setMode('drone');
    else if (k === 'v' || k === 'c') this.setMode(this.mode === 'car' ? 'walk' : this.mode === 'walk' ? 'drone' : 'car');
  };

  private input() {
    const k = this.keys;
    let y = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
    let x = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
    if (this.stick.x || this.stick.y) { x = this.stick.x; y = this.stick.y; }
    return {
      x, y,
      drift: k.has(' ') || this.touchButtons.has('drift'),
      up: k.has('e') || (this.mode === 'drone' && k.has(' ')) || this.touchButtons.has('up'),
      down: k.has('q') || (this.mode === 'drone' && k.has('Shift')) || this.touchButtons.has('down'),
      sprint: k.has('Shift'),
    };
  }

  private mountTouch() {
    const stick = this.root.querySelector<HTMLElement>('.roam-stick')!, knob = stick.querySelector('i')!;
    let id = -1;
    const move = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(dx, dy), s = l > 1 ? 1 / l : 1;
      this.stick = { x: dx * s, y: -dy * s };
      knob.style.transform = `translate(${dx * s * 34}px, ${dy * s * 34}px)`;
    };
    stick.addEventListener('pointerdown', e => { id = e.pointerId; stick.setPointerCapture(id); move(e); });
    stick.addEventListener('pointermove', e => { if (e.pointerId === id) move(e); });
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; id = -1; this.stick = { x: 0, y: 0 }; knob.style.transform = ''; };
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
    this.root.querySelectorAll<HTMLButtonElement>('[data-touch]').forEach(b => {
      const name = b.dataset.touch!;
      b.addEventListener('pointerdown', e => { e.preventDefault(); if (name === 'reset') { this.mode === 'car' ? this.resetCar() : this.jumpTo({ name: 'the road', ...this.nearestRoadXZ() }); } else this.touchButtons.add(name); });
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(t, () => this.touchButtons.delete(name));
    });
  }

  private nearestRoadXZ() { const [x, z] = this.position(); const hit = this.graph.nearest(x, z, 500); return { x: hit ? hit.point[0] : x, z: hit ? hit.point[1] : z }; }

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(innerWidth, innerHeight, false);
  };

  // ---------------------------------------------------------------- simulation
  private tick(now: number) {
    const dt = Math.min(0.05, this.lastNow ? (now - this.lastNow) / 1000 : 0.016);
    this.lastNow = now;
    this.fpsFrames.push(now);
    while (this.fpsFrames.length && now - this.fpsFrames[0] > 1000) this.fpsFrames.shift();
    const input = this.input();
    const paused = !this.root.querySelector<HTMLElement>('.roam-onboard')!.hidden;
    if (!paused) {
      if (this.mode === 'car') { const sub = 6; for (let i = 0; i < sub; i++) this.stepCar(dt / sub, input); this.checkStuck(dt, input); }
      else if (this.mode === 'walk') this.stepWalk(dt, input);
      else this.stepDrone(dt, input);
      this.stepTraffic(dt);
    }
    this.stepSparks(dt);
    this.updateCarMesh(dt);
    this.updateCamera(dt);
    this.beaconTime += dt;
    for (const s of this.spots) if (s.beacon) {
      s.beacon.material.uniforms.time.value = this.beaconTime;
      s.beacon.material.uniforms.strength.value = s.kind === 'audio' && (s.live ?? 0) > 0 ? 1.4 : 0.85;
      s.beacon.ring.scale.setScalar(1 + 0.12 * Math.sin(this.beaconTime * 3 + s.x));
    }
    if (this.route) (this.route.mesh.material as THREE.ShaderMaterial).uniforms.time.value = this.beaconTime;
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    if (now > this.nextTick) {
      this.nextTick = now + 250;
      this.updateHud();
      this.updateListening();
      this.drawMinimap();
      this.stats.fps = this.fpsFrames.length;
      this.stats.mode = this.mode;
      this.stats.speed = Math.round(Math.hypot(this.car.vx, this.car.vz) * 3.6);
    } else if (this.route || this.mode !== 'drone') this.drawMinimap();
  }
  private lastNow = 0;

  /** Arcade car: engine, brakes, speed-sensitive steering, grip that the handbrake breaks. */
  private stepCar(dt: number, input: ReturnType<Roam['input']>) {
    const c = this.car;
    const fx = Math.sin(c.h), fz = -Math.cos(c.h), rx = Math.cos(c.h), rz = Math.sin(c.h);
    let vf = c.vx * fx + c.vz * fz, vr = c.vx * rx + c.vz * rz;
    const maxSpeed = 36;
    if (input.y > 0) vf += (vf < 0 ? 26 : 13 * (1 - Math.max(0, vf) / maxSpeed)) * input.y * dt;
    else if (input.y < 0) vf += (vf > 0.5 ? -24 : -7) * -input.y * dt;
    else vf -= Math.sign(vf) * Math.min(Math.abs(vf), (1.6 + Math.abs(vf) * 0.04) * dt);
    vf = clamp(vf, -9, maxSpeed);
    if (input.drift) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);
    vr *= Math.exp(-(input.drift ? 1.1 : 7.5) * dt);
    c.steer += (input.x - c.steer) * Math.min(1, dt * 7);
    const angle = c.steer * 0.62 / (1 + Math.abs(vf) * 0.05);
    c.vx = fx * vf + rx * vr; c.vz = fz * vf + rz * vr;
    c.h += angle * vf / 2.6 * (input.drift ? 1.45 : 1) * dt;
    c.x += c.vx * dt; c.z += c.vz * dt;
    // Buildings: two circles along the body, pushed out of walls; velocity slides along.
    for (const off of [1.25, -1.25]) {
      const cx = c.x + Math.sin(c.h) * off, cz = c.z - Math.cos(c.h) * off;
      const hit = this.pushOut(cx, cz, 1.0);
      if (!hit) continue;
      c.x += hit.dx; c.z += hit.dz;
      const vn = c.vx * hit.nx + c.vz * hit.nz;
      if (vn < 0) {
        c.vx -= hit.nx * vn * 1.15; c.vz -= hit.nz * vn * 1.15;
        const loss = 1 - Math.min(0.3, -vn * 0.015);
        c.vx *= loss; c.vz *= loss;
        this.impact(-vn, cx - hit.nx, cz - hit.nz);
      }
    }
    this.keepInside(c);
  }

  private keepInside(o: { x: number; z: number; vx?: number; vz?: number }) {
    const d = Math.hypot(o.x, o.z);
    if (d < RADIUS - 4) return;
    const nx = -o.x / d, nz = -o.z / d;
    o.x += nx * (d - (RADIUS - 4)); o.z += nz * (d - (RADIUS - 4));
    if (o.vx !== undefined && o.vz !== undefined) {
      const vn = o.vx * nx + o.vz * nz;
      if (vn < 0) { o.vx -= nx * vn * 1.4; o.vz -= nz * vn * 1.4; }
    }
    if (performance.now() - this.lastEdgeToast > 4000) { this.lastEdgeToast = performance.now(); this.toast('Edge of the explorable area: turn around'); }
  }
  private lastEdgeToast = 0;

  /** Separate a circle from building walls. Returns the push and the average wall normal. */
  private pushOut(x: number, z: number, r: number) {
    let dx = 0, dz = 0, hits = 0;
    const s = this.segments;
    const seen = new Set<number>();
    for (const ox of [-1, 0, 1]) for (const oz of [-1, 0, 1]) {
      for (const i of this.segGrid.get(this.cellKey(x + ox * 16, z + oz * 16, 16)) ?? []) {
        if (seen.has(i)) continue; seen.add(i);
        const ax = s[i], az = s[i + 1], vx = s[i + 2] - ax, vz = s[i + 3] - az;
        const l2 = vx * vx + vz * vz || 1;
        const t = clamp(((x + dx - ax) * vx + (z + dz - az) * vz) / l2, 0, 1);
        const px = ax + vx * t, pz = az + vz * t;
        const ex = x + dx - px, ez = z + dz - pz, d = Math.hypot(ex, ez);
        if (d >= r || d < 1e-6) continue;
        dx += ex / d * (r - d); dz += ez / d * (r - d); hits++;
      }
    }
    if (!hits) return null;
    const l = Math.hypot(dx, dz) || 1;
    return { dx, dz, nx: dx / l, nz: dz / l };
  }

  private impact(speed: number, x: number, z: number, traffic = false) {
    this.lastHit = performance.now();
    if (speed < 2.5) return;
    this.stats.hits = Number(this.stats.hits) + 1;
    if (traffic) this.stats.trafficHits = Number(this.stats.trafficHits) + 1;
    this.shake = Math.min(0.9, this.shake + speed / 22);
    this.burst(x, 0.7, z, Math.min(40, Math.round(speed * 2)));
    if (speed > 9) this.flash(0.25);
  }

  private checkStuck(dt: number, input: ReturnType<Roam['input']>) {
    const speed = Math.hypot(this.car.vx, this.car.vz);
    if (input.y !== 0 && speed < 0.8 && performance.now() - this.lastHit < 600) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 1.6 && this.stuck - dt <= 1.6) this.toast('Stuck? Press R (or Reset) to get back on the road');
    if (this.stuck > 3.5) { this.resetCar(); this.toast('Back on the road'); }
  }

  private stepWalk(dt: number, input: ReturnType<Roam['input']>) {
    const w = this.walker;
    const speed = (input.sprint ? 8.5 : 4.2) * input.y;
    w.h += input.x * 2.4 * dt;
    w.x += Math.sin(w.h) * speed * dt; w.z += -Math.cos(w.h) * speed * dt;
    const hit = this.pushOut(w.x, w.z, 0.4);
    if (hit) { w.x += hit.dx; w.z += hit.dz; }
    this.keepInside(w);
    w.step += Math.abs(speed) * dt * 2.2;
    w.mesh.position.set(w.x, Math.abs(Math.sin(w.step)) * 0.08, w.z);
    w.mesh.rotation.y = -w.h;
  }

  private stepDrone(dt: number, input: ReturnType<Roam['input']>) {
    const d = this.drone;
    const speed = 14 + d.alt * 0.45;
    d.h += input.x * 1.6 * dt;
    d.x += Math.sin(d.h) * speed * input.y * dt; d.z += -Math.cos(d.h) * speed * input.y * dt;
    d.alt = clamp(d.alt + ((input.up ? 1 : 0) - (input.down ? 1 : 0)) * 40 * dt, 18, 260);
    this.keepInside(d);
  }

  // ---------------------------------------------------------------- traffic
  private placeTraffic(all = false) {
    const [px, pz] = this.position();
    for (const t of this.traffic) {
      if (!all && Math.hypot(t.x - px, t.z - pz) < 650 && t.bumped <= 0) continue;
      for (let tries = 0; tries < 40; tries++) {
        const ei = Math.floor(Math.random() * this.graph.edges.length), e = this.graph.edges[ei];
        const [ax, az] = this.graph.nodes[e.a];
        const d = Math.hypot(ax - px, az - pz);
        if (d < (all ? 40 : 160) || d > 480 || e.cls === 'service') continue;
        const from = Math.random() < 0.5 ? e.a : e.b;
        Object.assign(t, { edge: ei, from, t: Math.random() * e.len, bumped: 0, vx: 0, vz: 0, spin: 0,
          cruise: 7 + this.graph.rank(e) * 1.6 + Math.random() * 3, speed: 6 });
        this.trafficPose(t);
        t.shown = t.h;
        break;
      }
    }
  }

  private trafficPose(t: TrafficCar) {
    const e = this.graph.edges[t.edge], to = this.graph.other(e, t.from);
    const [ax, az] = this.graph.nodes[t.from], [bx, bz] = this.graph.nodes[to];
    const ux = (bx - ax) / e.len, uz = (bz - az) / e.len;
    const lane = clamp(e.width / 4, 1.5, 3.4) * (this.driveLeft ? -1 : 1);
    // Right-hand normal of the travel direction (x east, z south): (-uz, ux) points to the driver's right.
    t.x = ax + ux * t.t - uz * lane; t.z = az + uz * t.t + ux * lane;
    t.h = Math.atan2(ux, -uz);
  }

  private stepTraffic(dt: number) {
    const [px, pz] = this.position();
    const pv = this.mode === 'car' ? [this.car.vx, this.car.vz] : [0, 0];
    for (const t of this.traffic) {
      if (t.bumped > 0) {
        // Knocked off course: slide, spin, then rejoin the nearest road.
        t.bumped -= dt;
        t.x += t.vx * dt; t.z += t.vz * dt; t.h += t.spin * dt;
        const k = Math.exp(-1.8 * dt); t.vx *= k; t.vz *= k; t.spin *= Math.exp(-2.2 * dt);
        const hit = this.pushOut(t.x, t.z, 1.2);
        if (hit) { t.x += hit.dx; t.z += hit.dz; const vn = t.vx * hit.nx + t.vz * hit.nz; if (vn < 0) { t.vx -= hit.nx * vn * 1.3; t.vz -= hit.nz * vn * 1.3; } }
        if (t.bumped <= 0) {
          const road = this.graph.nearest(t.x, t.z, 40);
          if (!road) { t.bumped = 0; t.x = 1e6; continue; }
          const e = this.graph.edges[road.edge];
          const fwd = Math.sin(t.h) * (this.graph.nodes[e.b][0] - this.graph.nodes[e.a][0]) - Math.cos(t.h) * (this.graph.nodes[e.b][1] - this.graph.nodes[e.a][1]) >= 0;
          Object.assign(t, { edge: road.edge, from: fwd ? e.a : e.b, t: (fwd ? road.t : 1 - road.t) * e.len, speed: 0 });
        }
      } else {
        // Follow the road; slow for cars (and the player) ahead.
        let target = t.cruise;
        const fx = Math.sin(t.h), fz = -Math.cos(t.h);
        const ahead = (ox: number, oz: number) => {
          const rx = ox - t.x, rz = oz - t.z, along = rx * fx + rz * fz, side = Math.abs(rx * fz - rz * fx);
          if (along > 0 && along < 16 && side < 2.6) target = Math.min(target, Math.max(0, (along - 6) * 0.9));
        };
        for (const o of this.traffic) if (o !== t) ahead(o.x, o.z);
        if (this.mode !== 'drone') ahead(px, pz);
        t.speed += clamp(target - t.speed, -9 * dt, 3 * dt);
        t.t += t.speed * dt;
        let e = this.graph.edges[t.edge];
        let guard = 0;
        while (t.t > e.len && guard++ < 8) {
          t.t -= e.len;
          const node = this.graph.other(e, t.from);
          const [ax, az] = this.graph.nodes[t.from], [nx, nz] = this.graph.nodes[node];
          const dirx = (nx - ax) / e.len, dirz = (nz - az) / e.len;
          const options = this.graph.adj[node].filter(i => i !== t.edge);
          let next = t.edge;
          if (options.length) {
            // Prefer going roughly straight, with some turns.
            const scored = options.map(i => {
              const o = this.graph.edges[i], [ox, oz] = this.graph.nodes[this.graph.other(o, node)];
              const l = Math.hypot(ox - nx, oz - nz) || 1;
              return { i, s: ((ox - nx) * dirx + (oz - nz) * dirz) / l + Math.random() * 0.9 + (o.cls === 'service' ? -0.6 : 0) };
            }).sort((a, b) => b.s - a.s);
            next = scored[0].i;
          }
          // Arriving at `node`: the next edge (or a U-turn on this one) starts there.
          t.from = node;
          t.edge = next;
          e = this.graph.edges[next];
        }
        this.trafficPose(t);
      }
      // Player car hits traffic: both react.
      if (this.mode === 'car') for (const off of [1.25, -1.25]) {
        const cx = this.car.x + Math.sin(this.car.h) * off, cz = this.car.z - Math.cos(this.car.h) * off;
        const dx = cx - t.x, dz = cz - t.z, d = Math.hypot(dx, dz);
        if (d > 2.5 || d < 1e-3) continue;
        const nx = dx / d, nz = dz / d;
        const tvx = t.bumped > 0 ? t.vx : Math.sin(t.h) * t.speed, tvz = t.bumped > 0 ? t.vz : -Math.cos(t.h) * t.speed;
        const rel = (pv[0] - tvx) * nx + (pv[1] - tvz) * nz;
        this.car.x += nx * (2.5 - d) * 0.6; this.car.z += nz * (2.5 - d) * 0.6;
        if (rel < 0) {
          const j = -1.3 * rel / 2;
          this.car.vx += nx * j; this.car.vz += nz * j;
          t.vx = tvx - nx * j; t.vz = tvz - nz * j; t.spin = (Math.random() - 0.5) * 3 * Math.min(1, -rel / 8);
          t.bumped = 2.2;
          this.impact(-rel, t.x + nx * 1.2, t.z + nz * 1.2, true);
        }
        pv[0] = this.car.vx; pv[1] = this.car.vz;
      }
      t.shown += Math.atan2(Math.sin(t.h - t.shown), Math.cos(t.h - t.shown)) * Math.min(1, dt * 8);
    }
    // Recycle cars that fell far behind, and draw.
    if (Math.random() < dt * 2) this.placeTraffic();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    this.traffic.forEach((t, i) => {
      q.setFromAxisAngle(up, -t.shown);
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, one);
      this.trafficMesh.body.setMatrixAt(i, m); this.trafficMesh.cabin.setMatrixAt(i, m); this.trafficMesh.lights.setMatrixAt(i, m);
    });
    for (const im of [this.trafficMesh.body, this.trafficMesh.cabin, this.trafficMesh.lights]) im.instanceMatrix.needsUpdate = true;
    if (this.trafficMesh.body.instanceColor) this.trafficMesh.body.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- effects
  private burst(x: number, y: number, z: number, n: number) {
    const pos = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * pos.count);
      pos.setXYZ(i, x, y, z);
      this.sparkLife[i] = { vx: (Math.random() - 0.5) * 9, vy: Math.random() * 6 + 1, vz: (Math.random() - 0.5) * 9, life: 0.4 + Math.random() * 0.4 };
    }
  }

  private stepSparks(dt: number) {
    const pos = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let any = false;
    this.sparkLife.forEach((s, i) => {
      if (!s || s.life <= 0) return;
      any = true;
      s.life -= dt; s.vy -= 18 * dt;
      pos.setXYZ(i, pos.getX(i) + s.vx * dt, Math.max(0.05, pos.getY(i) + s.vy * dt), pos.getZ(i) + s.vz * dt);
      if (s.life <= 0) pos.setXYZ(i, 0, -50, 0);
    });
    if (any) pos.needsUpdate = true;
  }

  private flash(strength: number) {
    const f = this.root.querySelector<HTMLElement>('.roam-flash')!;
    f.style.transition = 'none'; f.style.opacity = String(strength);
    requestAnimationFrame(() => { f.style.transition = 'opacity .45s ease-out'; f.style.opacity = '0'; });
  }

  private toast(text: string) {
    const t = this.root.querySelector<HTMLElement>('.roam-toast')!;
    t.textContent = text; t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
  }
  private toastTimer = 0;

  private updateCarMesh(dt: number) {
    const c = this.car;
    c.mesh.position.set(c.x, 0, c.z);
    c.mesh.rotation.y = -c.h;
    const speed = c.vx * Math.sin(c.h) - c.vz * Math.cos(c.h);
    c.mesh.children.forEach(ch => {
      if (ch.name === 'front-wheel') ch.rotation.y = -c.steer * 0.5;
      if (ch.name.endsWith('wheel')) ch.rotation.x -= speed * dt / 0.36;
    });
    // Lean a little in turns for feel.
    c.mesh.rotation.z = clamp(-c.steer * Math.abs(speed) * 0.004, -0.06, 0.06);
  }

  private snapCamera() { this.updateCamera(1, true); }

  private updateCamera(dt: number, snap = false) {
    const [x, z] = this.position(), h = this.heading();
    const fx = Math.sin(h), fz = -Math.cos(h);
    const want = new THREE.Vector3(), look = new THREE.Vector3();
    if (this.mode === 'car') {
      const speed = Math.hypot(this.car.vx, this.car.vz);
      const back = 9 + speed * 0.08, height = 3.6 + speed * 0.03;
      want.set(x - fx * back, height, z - fz * back);
      look.set(x + fx * 5, 1.2, z + fz * 5);
      this.camera.fov += (62 + speed * 0.35 - this.camera.fov) * Math.min(1, dt * 3);
    } else if (this.mode === 'walk') {
      want.set(x - fx * 5.5, 2.8, z - fz * 5.5);
      look.set(x + fx * 3, 1.5, z + fz * 3);
      this.camera.fov += (60 - this.camera.fov) * Math.min(1, dt * 3);
    } else {
      const a = this.drone.alt;
      want.set(x - fx * a * 0.75, a, z - fz * a * 0.75);
      look.set(x, 0, z);
      this.camera.fov += (55 - this.camera.fov) * Math.min(1, dt * 3);
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * (this.mode === 'drone' ? 4 : 6));
    this.camPos.lerp(want, k); this.camLook.lerp(look, k);
    // Keep the camera out of buildings when walking or driving.
    if (this.mode !== 'drone') {
      const hit = this.pushOut(this.camPos.x, this.camPos.z, 0.8);
      if (hit) { this.camPos.x += hit.dx; this.camPos.z += hit.dz; }
    }
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- HUD
  private updateHud() {
    const speed = Math.round(Math.hypot(this.car.vx, this.car.vz) * 3.6);
    const box = this.root.querySelector<HTMLElement>('.roam-speed')!;
    if (this.mode === 'car') { box.querySelector('b')!.textContent = String(speed); box.querySelector('small')!.textContent = 'km/h'; box.querySelector<HTMLElement>('s')!.style.width = Math.min(100, speed / 1.3) + '%'; }
    else if (this.mode === 'walk') { box.querySelector('b')!.textContent = 'On foot'; box.querySelector('small')!.textContent = this.keys.has('Shift') ? 'running' : 'walking'; box.querySelector<HTMLElement>('s')!.style.width = '0'; }
    else { box.querySelector('b')!.textContent = Math.round(this.drone.alt) + ' m'; box.querySelector('small')!.textContent = 'drone altitude'; box.querySelector<HTMLElement>('s')!.style.width = Math.min(100, this.drone.alt / 2.6) + '%'; }
    // Nearest named street.
    const [x, z] = this.position();
    let name = '', best = 24;
    for (const ox of [-1, 0, 1]) for (const oz of [-1, 0, 1]) for (const i of this.nameGrid.get(this.cellKey(x + ox * 30, z + oz * 30, 30)) ?? []) {
      const n = this.names[i], vx = n.bx - n.ax, vz = n.bz - n.az, l2 = vx * vx + vz * vz || 1;
      const t = clamp(((x - n.ax) * vx + (z - n.az) * vz) / l2, 0, 1);
      const d = Math.hypot(x - n.ax - vx * t, z - n.az - vz * t);
      if (d < best) { best = d; name = n.name; }
    }
    const street = this.root.querySelector<HTMLElement>('.roam-street')!;
    street.querySelector('span')!.textContent = name;
    street.classList.toggle('on', Boolean(name));
    this.updateDest();
    if (this.route && this.routeRemaining() < 22) { const n = this.route.target.name; this.clearRoute(); this.toast('You are here: ' + n); }
  }

  private updateLabels() {
    const [px, pz] = this.position();
    const v = new THREE.Vector3();
    const far = this.mode === 'drone' ? 1400 : 520;
    const w = innerWidth, h = innerHeight;
    // Nearest first; skip labels that would overlap one already placed.
    const taken: [number, number][] = [];
    const order = this.spots.map(s => ({ s, d: Math.hypot(s.x - px, s.z - pz) })).sort((a, b) => (a.s.kind === 'landmark' ? 1 : 0) - (b.s.kind === 'landmark' ? 1 : 0) || a.d - b.d);
    for (const { s, d } of order) {
      if (!s.label) continue;
      v.set(s.x, s.kind === 'audio' ? 9 : 7, s.z).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      let visible = d < far && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (visible && taken.some(([tx, ty]) => Math.abs(tx - sx) < 150 && Math.abs(ty - sy) < 46)) visible = false;
      s.label.style.display = visible ? '' : 'none';
      if (!visible) continue;
      taken.push([sx, sy]);
      s.label.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      s.label.style.opacity = String(clamp(1.25 - d / far, 0.35, 1));
      s.label.style.zIndex = String(Math.round(2000 - d));
      s.label.querySelector('small')!.textContent = fmtDist(d);
    }
  }

  private renderRoadsImage() {
    const size = Math.ceil(RADIUS * 2.1 * this.mapScale);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1c1f22'; g.fillRect(0, 0, size, size);
    const o = size / 2, s = this.mapScale;
    g.fillStyle = '#2c4034';
    g.strokeStyle = 'transparent';
    for (const a of this.world.areas) {
      g.fillStyle = a.kind === 'water' ? '#1f4150' : '#2c4034';
      g.beginPath(); a.outer.forEach((p, i) => (i ? g.lineTo(o + p[0] * s, o + p[1] * s) : g.moveTo(o + p[0] * s, o + p[1] * s))); g.closePath(); g.fill();
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const r of [...this.world.roads].sort((a, b) => a.width - b.width)) {
      g.strokeStyle = r.width >= 10 ? '#d9d2bd' : r.width >= 7 ? '#8d908b' : r.drivable ? '#5d615f' : '#3e4542';
      g.lineWidth = Math.max(1, r.width * s * 1.1);
      g.beginPath(); r.pts.forEach((p, i) => (i ? g.lineTo(o + p[0] * s, o + p[1] * s) : g.moveTo(o + p[0] * s, o + p[1] * s))); g.stroke();
    }
    g.strokeStyle = 'rgba(245,189,82,.5)'; g.lineWidth = 2;
    g.beginPath(); g.arc(o, o, RADIUS * s, 0, Math.PI * 2); g.stroke();
    this.roadsImage = c;
  }

  /** Mini-map: heading-up and close; the big map is north-up and shows everything. */
  private drawMinimap(big = false) {
    const canvas = big ? this.root.querySelector<HTMLCanvasElement>('.roam-bigmap canvas')! : this.minimap;
    const dpr = Math.min(2, devicePixelRatio);
    const cssW = canvas.clientWidth || 200, cssH = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(cssW * dpr)) { canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr); }
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    const [px, pz] = this.position(), h = this.heading();
    const scale = big ? Math.min(W, H) / (RADIUS * 2.15) : (this.mode === 'drone' ? 0.32 : 0.6) * dpr; // px per metre
    const view = this.mapView(big, W, H, scale);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#16181b'; g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    if (!big) g.rotate(-h);
    g.scale(scale, scale);
    g.translate(-view.cx, -view.cz);
    const img = this.roadsImage, o = img.width / 2 / this.mapScale;
    g.drawImage(img, -o, -o, img.width / this.mapScale, img.height / this.mapScale);
    if (this.route) {
      g.strokeStyle = '#f5bd52'; g.lineWidth = 5 / scale; g.lineJoin = 'round';
      g.beginPath(); this.route.points.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
    }
    g.fillStyle = '#9da3a8';
    for (const t of this.traffic) { g.beginPath(); g.arc(t.x, t.z, 2.2 / scale * dpr, 0, Math.PI * 2); g.fill(); }
    for (const s of this.spots) {
      const pulse = s.kind === 'audio' && (s.live ?? 0) > 0 ? 1 + 0.35 * Math.sin(this.beaconTime * 5) : 1;
      g.fillStyle = '#' + s.color.toString(16).padStart(6, '0');
      g.beginPath(); g.arc(s.x, s.z, (s.kind === 'landmark' ? 2.6 : 4.4) * pulse * dpr / scale, 0, Math.PI * 2); g.fill();
      if (big) { g.fillStyle = '#efe9dc'; g.font = `${11 * dpr / scale}px Geist, sans-serif`; g.fillText(s.name.slice(0, 26), s.x + 7 * dpr / scale, s.z + 4 * dpr / scale); }
    }
    g.restore();
    // Player arrow.
    g.save();
    if (big) { g.translate(W / 2 + (px - view.cx) * scale, H / 2 + (pz - view.cz) * scale); g.rotate(h); }
    else g.translate(W / 2, H / 2);
    const a = 9 * dpr;
    g.fillStyle = this.mode === 'walk' ? '#b4ffe6' : '#f5bd52'; g.strokeStyle = '#111'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(0, -a); g.lineTo(a * 0.72, a * 0.8); g.lineTo(0, a * 0.35); g.lineTo(-a * 0.72, a * 0.8); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  private mapView(big: boolean, _W: number, _H: number, _scale: number) {
    const [px, pz] = this.position();
    return big ? { cx: 0, cz: 0 } : { cx: px, cz: pz };
  }

  private onMapClick(canvas: HTMLCanvasElement, e: MouseEvent, big: boolean) {
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    let x = (e.clientX - r.left) * dpr - canvas.width / 2, y = (e.clientY - r.top) * dpr - canvas.height / 2;
    const scale = big ? Math.min(canvas.width, canvas.height) / (RADIUS * 2.15) : (this.mode === 'drone' ? 0.32 : 0.6) * Math.min(2, devicePixelRatio);
    if (!big) { const h = this.heading(), c = Math.cos(h), s = Math.sin(h); [x, y] = [x * c - y * s, x * s + y * c]; }
    const view = this.mapView(big, 0, 0, scale);
    const wx = view.cx + x / scale, wz = view.cz + y / scale;
    // Snap to a place if the tap was on one.
    const near = this.spots.map(s => ({ s, d: Math.hypot(s.x - wx, s.z - wz) })).sort((a, b) => a.d - b.d)[0];
    const target = near && near.d < 18 / scale * dpr ? near.s : { name: 'Map point', x: wx, z: wz };
    if (big) this.toggleBigMap(false);
    this.setRoute(target);
  }

  private toggleBigMap(open?: boolean) {
    const big = this.root.querySelector<HTMLElement>('.roam-bigmap')!;
    big.hidden = !(open ?? big.hidden);
    if (!big.hidden) requestAnimationFrame(() => this.drawMinimap(true));
  }

  private onboarding(show: boolean) {
    const box = this.root.querySelector<HTMLElement>('.roam-onboard')!;
    box.hidden = !show;
    if (!show) { localStorage.setItem('nearby.roam.onboarded', '1'); return; }
    const keys = this.touch
      ? `<li><b>Move</b><span>Drag the stick: up to go, down to brake or reverse, sideways to steer</span></li>
         <li><b>Drift</b><span>Hold Drift while turning</span></li>`
      : `<li><b>Drive</b><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows · <kbd>Space</kbd> drift · <kbd>R</kbd> back on the road</span></li>
         <li><b>Explore</b><span><kbd>1</kbd> car · <kbd>2</kbd> walk · <kbd>3</kbd> drone (<kbd>E</kbd>/<kbd>Q</kbd> up and down)</span></li>
         <li><b>Find</b><span><kbd>G</kbd> places · <kbd>M</kbd> big map · <kbd>Esc</kbd> back to the map</span></li>`;
    box.innerHTML = `<div class="roam-onboard-card">
        <span class="roam-kicker">Free roam · ${esc(this.options.place?.locality ?? 'your area')}</span>
        <h2>Explore your neighbourhood</h2>
        <p>Real streets and buildings from the map. Drive, walk or fly a drone. Glowing columns mark places: activities, rooms, events and live audio.</p>
        <ul>${keys}
          <li><b>Go places</b><span>Tap the mini-map or open Places to get a route, or jump straight there</span></li>
          <li><b>Live audio</b><span>Get within ${LISTEN_RADIUS} m of a pink column to listen in; the people talking can see you are listening</span></li></ul>
        <button type="button">Start exploring</button>
      </div>`;
    box.querySelector('button')!.onclick = () => this.onboarding(false);
  }

  // ---------------------------------------------------------------- live audio venues
  private updateListening() {
    if (this.joining) return;
    const [x, z] = this.position();
    const venues = this.spots.filter(s => s.kind === 'audio' && ((s.live ?? 0) > 0 || this.audio?.id === s.id.slice(2)));
    const nearest = venues.map(s => ({ s, d: Math.hypot(s.x - x, s.z - z) })).sort((a, b) => a.d - b.d)[0];
    for (const id of [...this.muteUntilOutside]) { const s = this.spots.find(o => o.id === id); if (!s || Math.hypot(s.x - x, s.z - z) > LISTEN_RADIUS + 6) this.muteUntilOutside.delete(id); }
    if (this.audio) {
      const venue = this.spots.find(s => s.id === 'c:' + this.audio!.id);
      const d = venue ? Math.hypot(venue.x - x, venue.z - z) : Infinity;
      if (!this.audio.speaking) {
        if (d > LISTEN_RADIUS + 6) { this.stopAudio(); return; }
        const volume = Math.pow(clamp(1 - d / LISTEN_RADIUS, 0, 1), 1.2);
        this.audio.session.setVolume(volume);
        this.stats.volume = Number(volume.toFixed(2)); this.stats.distance = Math.round(d);
      }
      this.renderLive(venue, d);
      return;
    }
    if (nearest && nearest.d < LISTEN_RADIUS && !this.muteUntilOutside.has(nearest.s.id)) void this.listen(nearest.s);
  }

  private async listen(venue: Spot, speak = false) {
    this.joining = true;
    const id = venue.id.slice(2);
    const session = new AudioSession(id, this.options.user.name, () => { if (this.audio?.session === session) this.renderLive(venue); }, speak ? 'speak' : 'listen');
    try {
      await session.join();
      if (this.disposed) { session.leave(); return; }
      this.audio = { id, session, speaking: speak };
      if (speak) session.setVolume(1);
      this.renderLive(venue);
      if (!speak) this.toast('Listening to ' + venue.name);
    } catch (error) {
      this.toast((error as Error).message);
      this.muteUntilOutside.add(venue.id);
    } finally { this.joining = false; }
  }

  private stopAudio() {
    this.stats.volume = -1;
    this.audio?.session.leave();
    this.audio = undefined;
    this.root.querySelector<HTMLElement>('.roam-live')!.hidden = true;
  }

  private renderLive(venue?: Spot, distance?: number) {
    const box = this.root.querySelector<HTMLElement>('.roam-live')!;
    if (!this.audio || !venue) { box.hidden = true; return; }
    const people = [...this.audio.session.participants.values()];
    const speakers = people.filter(p => p.role !== 'listener'), listeners = people.filter(p => p.role === 'listener');
    const d = distance ?? Math.hypot(venue.x - this.position()[0], venue.z - this.position()[1]);
    box.hidden = false;
    box.innerHTML = `<header><span class="roam-live-dot"></span><b>LIVE · ${esc(venue.name)}</b><em>${this.audio.speaking ? 'in the conversation' : 'listening'}</em></header>
      ${this.audio.speaking ? '' : `<div class="roam-live-volume"><i style="width:${Math.round(clamp(1 - d / LISTEN_RADIUS, 0, 1) * 100)}%"></i></div><small>${Math.round(d)} m away · get closer to hear more</small>`}
      <ul>${speakers.map(p => `<li class="${p.state}"><span style="--level:${p.level.toFixed(2)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}</li>`).join('')}</ul>
      <p class="roam-live-listeners">${listeners.length} listening${listeners.length ? ': ' + listeners.map(p => esc(p.name.replace(/ \(listening(, you)?\)/, '') + (p.me ? ' (you)' : ''))).join(', ') : ''}</p>
      <div class="roam-live-actions">${this.audio.speaking
        ? `<button type="button" data-act="mute">${this.audio.session.muted ? 'Unmute' : 'Mute'}</button><button type="button" data-act="leave">Leave</button>`
        : `<button type="button" data-act="speak">Join the conversation</button><button type="button" data-act="stop">Stop listening</button>`}</div>
      <footer>The people talking can see who is listening. Nothing is recorded.</footer>`;
    const act = (name: string, fn: () => void) => { const b = box.querySelector<HTMLButtonElement>(`[data-act=${name}]`); if (b) b.onclick = fn; };
    act('mute', () => { this.audio?.session.toggleMute(); this.renderLive(venue); });
    act('leave', () => { this.stopAudio(); this.muteUntilOutside.add(venue.id); });
    act('stop', () => { this.stopAudio(); this.muteUntilOutside.add(venue.id); });
    act('speak', () => { this.stopAudio(); void this.listen(venue, true); });
  }
}
