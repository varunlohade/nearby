// Free Roam: an open-world sandbox of the visitor's real neighbourhood.
// Drive, walk or fly a drone through streets and buildings streamed from the
// map, take any car, find places (activities, rooms, events, live audio, parks),
// follow a GPS route or jump there, and hear live audio venues up close.
//
// References and credits (see also the in-app credits on the help card):
//   Character "Business Man" by Quaternius, CC0 1.0 (poly.pizza/m/JFrLIKqvCH).
//   Sketchbook by swift502 (MIT): spring-based character velocity/rotation
//     (springs.ts), camera-relative movement, and the enter/exit-car flow
//     (walk to the door seat point, door gesture, take the seat; reverse to exit).
//   pmndrs/racing-game (MIT): raycast-vehicle numbers and the speed/steer-based
//     chase camera offset (vehicles.ts and updateCamera below).
//   Bruno Simon's folio-2019 (MIT): playful cannon-es tuning on low-end devices.
//   cannon-es (MIT) physics. three.js webgl_animation_skinning_blending (MIT):
//     crossfaded clip weights (human.ts).
// Map data © OpenStreetMap contributors via OpenFreeMap/OpenMapTiles.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type maplibregl from 'maplibre-gl';
import './roam.css';
import { AudioSession } from '../create/audio';
import type { Activity, Place } from '../world/earth';
import { RoamPlayers } from './players';
import { Frame, type XZ } from './data';
import { WorldStream } from './stream';
import { COLORS, makeBeacon, makeCar, makeRoute, makeSparks, makeTraffic } from './build';
import { Crowd, loadHuman, Walker, type HumanAsset } from './human';
import { DynamicResolution, detectQuality } from './quality';
import { Spring } from './springs';
import { CAR, Vehicle } from './vehicles';

export interface RoamOptions {
  map: maplibregl.Map;
  place?: Place;
  activities: Activity[];
  user: { name: string };
  openChat: (room: string, title: string, kind: string) => void;
  liveUser: () => {name:string; canCall:boolean};
  callUser: (id:string, name:string) => void;
  meeting?: [number, number];
  onExit?: () => void;
}

type Mode = 'car' | 'walk' | 'drone';
interface Spot {
  id: string; name: string; kind: string; x: number; z: number; color: number;
  live?: number; listening?: number; detail?: string;
  beacon?: ReturnType<typeof makeBeacon>; label?: HTMLElement;
}
interface TrafficCar {
  edge: number; from: number; t: number; speed: number; cruise: number; color: number;
  x: number; z: number; h: number; shown: number;
  body?: CANNON.Body;       // kinematic near the player, dynamic after a crash
  crashed: number;          // seconds since it became dynamic (0 = driving)
  still: number;            // seconds at rest while crashed
  sinking: number;
}
interface Prop { body: CANNON.Body; mesh: THREE.Mesh }

const LISTEN_RADIUS = 60;
const STEP = 1 / 60;
const KIND_COLOR: Record<string, number> = {
  activity: 0xf5bd52, event: 0xf5bd52, room: 0x75c4ee, audio: 0xf495ae, community: 0x9dc48c, park: 0x7fbf8a, landmark: 0xe8dcc1,
};
const KIND_LABEL: Record<string, string> = {
  activity: 'Activity', event: 'Event', room: 'Chat room', audio: 'Live audio', community: 'Community', park: 'Park', landmark: 'Landmark',
};
const CAR_COLORS = [0xd46b59, 0x82abb9, 0xc8c6ba, 0x8994b7, 0x6f8f72, 0xb88a5e, 0x9b6f8e, 0xe0e0d8, 0x4f6d8f, 0xa14848];
// Countries that drive on the left, so traffic keeps to the correct side.
const LEFT_HAND = /India|United Kingdom|Ireland|Japan|Australia|New Zealand|South Africa|Singapore|Malaysia|Indonesia|Thailand|Sri Lanka|Pakistan|Bangladesh|Nepal|Kenya|Hong Kong|Cyprus|Malta|Jamaica/i;

const esc = (s: string) => s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmtDist = (m: number) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km');
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

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
  private camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 1200);
  private frame!: Frame;
  private stream!: WorldStream;
  private graphVersion = -1;
  private spots: Spot[] = [];
  private spotsAt: XZ = [1e9, 1e9];
  private savedCamera?: maplibregl.CameraOptions;
  private raf = 0;
  private disposed = false;
  private touch = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
  private q = detectQuality();
  private dynres?: DynamicResolution;
  private driveLeft = false;
  private ground!: THREE.Mesh;

  // Physics.
  private world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  private physAcc = 0;
  private pendingCrash: { t: TrafficCar; vx: number; vz: number }[] = [];
  private props: Prop[] = [];

  // Player.
  private mode: Mode = 'car';
  private vehicles: Vehicle[] = [];
  private driving?: Vehicle;
  private lastCar?: Vehicle;
  private human?: Walker;
  private crowd?: Crowd;
  private players?: RoamPlayers;
  private humanAsset?: Promise<HumanAsset | null>;
  private walker = { x: 0, z: 0, h: 0 };
  private drone = { x: 0, z: 0, h: 0, alt: 70 };
  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private touchButtons = new Set<string>();
  private running = false;
  private camYaw = new Spring(60, 12, 0.7);
  private dragYaw = 0;
  private dragUntil = 0;
  private lastHit = 0;
  private stuck = 0;
  private shake = 0;
  private nearCar?: Vehicle | TrafficCar;
  private seat = 0;                 // seconds left in the enter/exit transition

  // Traffic and effects.
  private traffic: TrafficCar[] = [];
  private trafficMesh!: ReturnType<typeof makeTraffic>;
  private sparks = makeSparks(120);
  private sparkLife: { vx: number; vy: number; vz: number; life: number }[] = [];
  private beaconTime = 0;
  private route?: { mesh: THREE.Mesh; points: XZ[]; target: Spot | { name: string; x: number; z: number }; checked: number };

  // Camera smoothing.
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camArm = 1;               // spring-arm length 0..1: walls pull it in at once, it eases back out
  private camAim = new THREE.Vector3();

  // Audio venues.
  private audio?: { id: string; session: AudioSession; speaking: boolean };
  private muteUntilOutside = new Set<string>();
  private joining = false;

  // HUD and stats.
  private minimap!: HTMLCanvasElement;
  private fpsFrames: number[] = [];
  private nextTick = 0;
  private timers: number[] = [];
  private lastNow = 0;
  private toastTimer = 0;
  private stats: Record<string, number | string> = {};
  private started = performance.now();

  // Scratch objects (no per-frame allocations).
  private readonly tmp = {
    m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), up: new THREE.Vector3(0, 1, 0),
    want: new THREE.Vector3(), look: new THREE.Vector3(), v: new THREE.Vector3(), hit: { dx: 0, dz: 0, nx: 0, nz: 0 }, cq: new CANNON.Quaternion(),
  };
  private inputState = { x: 0, y: 0, drift: false, up: false, down: false, sprint: false };
  /** Test-only autopilot (?roamdebug): follows a route through the streets. */
  private autopilot?: { points: XZ[]; i: number; slow: number; dir: number; back: number };

  constructor(private options: RoamOptions) {}

  // ---------------------------------------------------------------- lifecycle
  async start() {
    this.mountShell();
    this.humanAsset = loadHuman().catch(error => { console.warn('[roam] character model unavailable', error); return null; });
    try {
      await this.loadFirstArea();
    } catch (error) {
      console.error('[roam]', error);
      const notice=this.root.querySelector('.roam-loading p');
      if(notice){
        notice.textContent='No drivable streets loaded here.';
        const back=document.createElement('button');back.textContent='Choose another spot on the map';back.onclick=this.exit;notice.after(back);
      }
      return;
    }
    if (this.disposed) return;
    this.setupScene();
    this.setupPhysics();
    await this.loadSpots();
    const asset = await this.humanAsset;
    if (this.disposed) return;
    if (asset) {
      this.human = new Walker(asset);
      this.human.object.visible = false;
      this.scene.add(this.human.object);
      this.crowd = new Crowd(asset, this.stream.graph, this.q.pedestrians, this.touch ? 110 : 150);
      this.scene.add(this.crowd.group);
    }
    this.spawn();
    this.players = new RoamPlayers(this.root,this.scene,this.frame,asset,() => this.position(),this.options.liveUser,this.options.callUser);
    this.root.querySelector('.roam-loading')!.remove();
    this.stats.firstPlayableMs = Math.round(performance.now() - this.started);
    if (localStorage.getItem('nearby.roam.onboarded') !== '1') this.onboarding(true);
    this.timers.push(window.setInterval(() => void this.loadSpots(), 15000));
    this.timers.push(window.setInterval(() => { const [x, z] = this.position(); this.crowd?.populate(x, z, this.spots); this.manageParked(); this.manageProps(); }, 2000));
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
    this.players?.dispose();
    this.crowd?.dispose();
    this.human?.body.dispose();
    this.stream?.dispose();
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
      <div class="roam-loading-hint" hidden>Loading area…</div>
      <button type="button" class="roam-enter" hidden></button>
      <div class="roam-mini"><canvas width="200" height="200" aria-label="Mini-map: tap to set a route"></canvas><button type="button" class="roam-mini-big">Map</button></div>
      <div class="roam-speed"><b>0</b><small>km/h</small><i><s></s></i></div>
      <aside class="roam-places" hidden><header><b>Places nearby</b><button type="button" aria-label="Close">×</button></header><ol></ol></aside>
      <div class="roam-bigmap" hidden><canvas></canvas><p>Tap anywhere to get a route there</p><button type="button">Close</button></div>
      <div class="roam-social"><button type="button" class="roam-chat">Talk nearby</button><button type="button" class="roam-peer-call" hidden></button><button type="button" class="roam-invite" title="Share your spot in Free Roam">Invite</button></div>
      <section class="roam-live" hidden></section>
      <div class="roam-touch" ${this.touch ? '' : 'hidden'}>
        <div class="roam-stick"><i></i></div>
        <div class="roam-touch-buttons">
          <button type="button" data-touch="up" class="drone-only">▲</button>
          <button type="button" data-touch="down" class="drone-only">▼</button>
          <button type="button" data-touch="drift" class="car-only">Drift</button>
          <button type="button" data-touch="run" class="walk-only" aria-pressed="false">Run</button>
          <button type="button" data-touch="wave" class="walk-only">Wave</button>
          <button type="button" data-touch="reset">Reset</button>
        </div>
      </div>
      <div class="roam-loading"><b>Building your neighbourhood…</b><p>Reading streets and buildings from the map</p><i class="roam-progress"><s></s></i></div>
      <div class="roam-onboard" hidden></div>`;
    document.body.append(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    q('.roam-exit').onclick = this.exit;
    q('.roam-chat').onclick = () => {
      this.keys.clear();
      const room = this.conversation();
      this.options.openChat(room.id,room.title,room.kind);
    };
    q('.roam-invite').onclick = async () => {
      const [lng,lat] = this.frame.toLngLat(...this.position());
      const link = new URL('/',location.href);
      link.searchParams.set('at',lat.toFixed(5)+','+lng.toFixed(5));
      link.searchParams.set('meet','1');
      try {
        if (navigator.share) await navigator.share({title:'Meet me in Free Roam',url:link.href});
        else { await navigator.clipboard.writeText(link.href); this.toast('Meeting link copied'); }
      } catch (error) { if ((error as Error).name !== 'AbortError') window.prompt('Copy your Free Roam meeting link',link.href); }
    };
    q('.roam-help').onclick = () => this.onboarding(true);
    q('.roam-places-btn').onclick = () => this.togglePlaces();
    q('.roam-places header button').onclick = () => this.togglePlaces(false);
    q('.roam-mini-big').onclick = () => this.toggleBigMap(true);
    q('.roam-bigmap button').onclick = () => this.toggleBigMap(false);
    q('.roam-dest [data-act=clear]').onclick = () => this.clearRoute();
    q('.roam-dest [data-act=jump]').onclick = () => { if (this.route) this.jumpTo(this.route.target); };
    q('.roam-enter').onclick = () => this.useCar();
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => { b.onclick = () => this.setMode(b.dataset.mode as Mode); });
    this.minimap = q('.roam-mini canvas');
    this.minimap.onclick = e => this.onMapClick(this.minimap, e, false);
    q<HTMLCanvasElement>('.roam-bigmap canvas').onclick = e => this.onMapClick(q('.roam-bigmap canvas'), e, true);
    addEventListener('keydown', this.onKey, true);
    addEventListener('keyup', this.onKey, true);
    addEventListener('resize', this.onResize);
    this.mountTouch();
    this.mountLook();
  }

  private progress(value: number, text?: string) {
    const bar = this.root.querySelector<HTMLElement>('.roam-progress s');
    if (bar) bar.style.width = Math.round(value * 100) + '%';
    if (text) { const p = this.root.querySelector('.roam-loading p'); if (p) p.textContent = text; }
  }

  private async loadFirstArea() {
    const map = this.options.map, place = this.options.place;
    const center = map.getCenter().wrap();
    this.driveLeft = LEFT_HAND.test(place?.country ?? '');
    this.savedCamera = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    this.progress(0.15);
    map.jumpTo({ center: [center.lng, center.lat], zoom: 14.2, bearing: 0, pitch: 0 });
    await Promise.race([new Promise(resolve => map.once('idle', resolve)), new Promise(resolve => setTimeout(resolve, 9000))]);
    if (this.disposed) return;
    this.progress(0.55, 'Laying out the streets');
    this.frame = new Frame(center.lng, center.lat);
    this.stream = new WorldStream(map, this.frame, this.scene, this.q);
    this.stream.readAll();
    if (!this.stream.graph.edges.length) this.stream.update(0, 0, 0, -1);
    if (!this.stream.graph.edges.length) throw new Error('No roads');
  }

  // ---------------------------------------------------------------- scene and physics
  private setupScene() {
    const canvas = this.root.querySelector<HTMLCanvasElement>('.roam-canvas')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.q.antialias, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.dynres = new DynamicResolution(this.renderer, this.q.dprCap);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Haze in the atlas charcoal hides chunks building in the distance.
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, this.q.fogFar * 0.3, this.q.fogFar);
    this.camera.far = this.q.fogFar + 60;
    this.camera.updateProjectionMatrix();
    this.scene.add(new THREE.HemisphereLight(0xc9d3e6, 0x202326, 1.45));
    const sun = new THREE.DirectionalLight(0xffe2bd, 1.1); sun.position.set(-300, 420, 200); this.scene.add(sun);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(this.q.fogFar * 3, this.q.fogFar * 3), new THREE.MeshLambertMaterial({ color: COLORS.ground }));
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground, this.sparks);
    this.trafficMesh = makeTraffic(this.q.traffic);
    this.scene.add(this.trafficMesh.body, this.trafficMesh.cabin, this.trafficMesh.lights);
    for (let i = 0; i < this.q.traffic; i++) {
      const color = CAR_COLORS[i % CAR_COLORS.length];
      this.trafficMesh.body.setColorAt(i, new THREE.Color(color));
      this.traffic.push({ edge: 0, from: 0, t: 0, speed: 0, cruise: 10, color, x: 1e6, z: 1e6, h: 0, shown: 0, crashed: 0, still: 0, sinking: 0 });
    }
    this.stats = {
      tier: this.q.tier, tierReason: this.q.reason, fps: 0, dpr: 0, mode: 'car', speed: 0, hits: 0, trafficHits: 0, crashes: 0,
      volume: -1, distance: -1, walker: '-', pedestrians: this.q.pedestrians, pedsVisible: 0, heapMB: 0, chunks: 0, built: 0,
      buildMs: 0, maxBuildMs: 0, bodies: 0, vehicles: 0, splash: 0, water: -1, firstPlayableMs: 0,
    };
    (window as unknown as { __roamStats: unknown }).__roamStats = this.stats;
    if (new URLSearchParams(location.search).has('roamdebug')) (window as unknown as { __roam: unknown }).__roam = this.debugHooks();
  }

  private setupPhysics() {
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    this.world.defaultContactMaterial.friction = 0.3;     // folio-2019 floor/wheel friction
    this.world.defaultContactMaterial.restitution = 0.2;  // folio-2019 default restitution
    const ground = new CANNON.Body({ mass: 0 });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ground);
  }

  private newVehicle(color: number, x: number, z: number, heading: number) {
    const v = new Vehicle(this.world, makeCar(color), color, 0.9 + (CAR_COLORS.indexOf(color) % 3) * 0.08);
    v.place(x, z, heading);
    this.scene.add(v.mesh);
    this.vehicles.push(v);
    return v;
  }

  private removeVehicle(v: Vehicle) {
    v.remove();
    this.scene.remove(v.mesh);
    v.mesh.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    this.vehicles.splice(this.vehicles.indexOf(v), 1);
  }

  // ---------------------------------------------------------------- places
  private async loadSpots() {
    const [px, pz] = this.position();
    this.spotsAt = [px, pz];
    const keep = new Map(this.spots.map(s => [s.id, s]));
    const next: Spot[] = [];
    const R = Math.max(1200, this.q.viewRadius * 2);
    const add = (s: Spot) => {
      if (Math.hypot(s.x - px, s.z - pz) > R) return;
      const old = keep.get(s.id);
      if (old) { Object.assign(old, { live: s.live, listening: s.listening, name: s.name, detail: s.detail }); next.push(old); }
      else next.push(s);
    };
    const place = this.options.place;
    const created = new Set<string>();
    try {
      const [w, n] = this.frame.toLngLat(px - R, pz - R), [e, s] = this.frame.toLngLat(px + R, pz + R);
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
    for (const l of this.stream.landmarks) add({ id: 'l:' + l.name, name: l.name, kind: l.kind === 'park' ? 'park' : 'landmark', x: l.x, z: l.z, color: KIND_COLOR[l.kind === 'park' ? 'park' : 'landmark'] });
    for (const old of this.spots) if (!next.includes(old)) { old.label?.remove(); if (old.beacon) this.scene.remove(old.beacon.group); }
    this.spots = next.slice(0, 80);
    for (const s of this.spots) {
      if (!s.beacon && s.kind !== 'landmark') {
        s.beacon = makeBeacon(s.color, s.kind === 'audio' ? 90 : s.kind === 'park' ? 30 : 60);
        s.beacon.group.position.set(s.x, 0, s.z);
        this.scene.add(s.beacon.group);
      }
      if (!s.label) {
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'roam-label kind-' + s.kind;
        label.onclick = () => this.setRoute(s);
        s.label = label;
        this.root.querySelector('.roam-labels')!.append(label);
      }
      const live = s.kind === 'audio' ? `<em>${s.live ?? 0} live${s.listening ? ` · ${s.listening} listening` : ''}</em>` : '';
      s.label.innerHTML = `<span>${esc(KIND_LABEL[s.kind] ?? s.kind)}</span><b>${esc(s.name)}</b>${live}<small></small>`;
    }
    this.renderPlaces();
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
    const start = this.stream.graph.spawnNear(target[0], target[1]) ?? { point: target, heading: 0 };
    if (this.options.meeting) start.point = this.frame.toLocal(...this.options.meeting);
    this.stream.buildAround(start.point[0], start.point[1]);
    this.driving = this.newVehicle(COLORS.accent, start.point[0], start.point[1], start.heading);
    this.driving.driver = 'player';
    this.walker = { x: start.point[0], z: start.point[1], h: start.heading };
    this.graphVersion = this.stream.graphVersion;
    this.placeTraffic(true);
    this.crowd?.populate(start.point[0], start.point[1], this.spots, true);
    this.manageParked();
    this.manageProps();
    this.snapCamera();
  }

  private setMode(mode: Mode) {
    if (mode === this.mode) return;
    const [x, z] = this.position();
    if (mode === 'car') {
      // Back into the nearest car you own, or the car you were last in comes to you.
      const mine = this.driving ?? (this.lastCar && this.vehicles.includes(this.lastCar) ? this.lastCar : undefined);
      if (this.mode === 'walk' && this.nearCar) { this.useCar(); return; }
      if (!mine) { const s = this.stream.graph.spawnNear(x, z); if (!s) return; this.enter(this.newVehicle(COLORS.accent, s.point[0], s.point[1], s.heading)); return; }
      if (Math.hypot(mine.x - x, mine.z - z) > 10) { const s = this.stream.graph.spawnNear(x, z); if (s) mine.place(s.point[0], s.point[1], s.heading); }
      this.enter(mine);
      return;
    }
    if (this.mode === 'car' && this.driving) this.leave(false);
    if (mode === 'walk') {
      if (this.mode === 'drone') { const hit = this.stream.graph.nearest(x, z, 200); [this.walker.x, this.walker.z] = hit ? hit.point : [x, z]; this.walker.h = this.drone.h; }
      this.human?.place(this.walker.x, this.walker.z, this.walker.h);
      this.camYaw.reset(this.walker.h); this.dragYaw = 0;
    } else {
      this.drone.x = x; this.drone.z = z; this.drone.h = this.heading(); this.drone.alt = 70;
    }
    this.setModeClass(mode);
  }

  private setModeClass(mode: Mode) {
    this.mode = mode;
    if (this.human) this.human.object.visible = mode === 'walk';
    this.root.classList.toggle('mode-drone', mode === 'drone');
    this.root.classList.toggle('mode-walk', mode === 'walk');
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  }

  /** Get into a car (Sketchbook flow: to the door, door gesture, take the seat). */
  private enter(v: Vehicle) {
    for (const o of this.vehicles) if (o !== v && o.driver === 'player') { o.driver = 'none'; o.park(); }
    this.driving = v; v.driver = 'player'; v.body.wakeUp();
    this.human?.body.gestureOnce(this.human.body.interact);
    this.seat = 0.45;
    this.setModeClass('car');
  }

  /** Step out beside the driver's door; the car stays parked as a physics body. */
  private leave(toWalk = true) {
    const v = this.driving;
    if (!v) return;
    v.driver = 'none'; v.park(); this.lastCar = v;
    const h = v.heading, side = this.driveLeft ? 1 : -1;           // door on the kerb side away from traffic
    let x = v.x + Math.cos(h) * 1.9 * side, z = v.z + Math.sin(h) * 1.9 * side;
    const hit = this.stream.pushOut(x, z, 0.5, this.tmp.hit);
    if (hit) { x += hit.dx; z += hit.dz; }
    this.walker = { x, z, h };
    this.driving = undefined;
    if (toWalk) {
      this.human?.place(x, z, h);
      this.human?.body.gestureOnce(this.human.body.interact);
      this.camYaw.reset(h);
      this.setModeClass('walk');
    }
  }

  /** On foot near a car: take it. In a car: get out. */
  private useCar() {
    if (this.mode === 'car') { this.leave(); return; }
    if (this.mode !== 'walk' || !this.nearCar) return;
    const target = this.nearCar;
    if (target instanceof Vehicle) { this.enter(target); this.toast('In the car'); return; }
    // A traffic car: the driver gets out and runs off (cartoon), and you drive it.
    const t = target;
    const v = this.newVehicle(t.color, t.x, t.z, t.h);
    const side = this.driveLeft ? -1 : 1;
    this.crowd?.flee(t.x + Math.cos(t.h) * 2 * side, t.z + Math.sin(t.h) * 2 * side, this.walker.x, this.walker.z);
    this.retireTraffic(t);
    this.enter(v);
    this.toast('Car taken');
    this.stats.taken = Number(this.stats.taken ?? 0) + 1;
  }

  private position(): XZ {
    if (this.mode === 'car' && this.driving) return [this.driving.x, this.driving.z];
    return this.mode === 'drone' ? [this.drone.x, this.drone.z] : [this.walker.x, this.walker.z];
  }
  private heading() { return this.mode === 'car' && this.driving ? this.driving.heading : this.mode === 'walk' ? this.walker.h : this.drone.h; }

  private resetCar() {
    const v = this.driving;
    if (!v) return;
    const s = this.stream.graph.spawnNear(v.x, v.z);
    if (s) v.place(s.point[0], s.point[1], s.heading);
    this.stuck = 0;
  }

  /** Fast travel: appear on the road next to a place. */
  private jumpTo(target: { x: number; z: number; name: string }) {
    this.flash(0.9);
    const road = this.stream.graph.nearest(target.x, target.z, 150);
    const [x, z] = road ? road.point : [target.x, target.z];
    this.stream.buildAround(x, z);
    if (this.mode === 'car' && this.driving) { const s = this.stream.graph.spawnNear(x, z); this.driving.place(s?.point[0] ?? x, s?.point[1] ?? z, s?.heading ?? 0); }
    else if (this.mode === 'walk') { this.walker.x = x; this.walker.z = z; this.human?.place(x, z, this.walker.h); }
    else { this.drone.x = target.x; this.drone.z = target.z; }
    this.clearRoute();
    this.snapCamera();
    this.toast('Arrived at ' + target.name);
  }

  // ---------------------------------------------------------------- GPS route
  private setRoute(target: Spot | { name: string; x: number; z: number }) {
    this.clearRoute();
    const points = this.stream.graph.route(this.position(), [target.x, target.z]);
    if (!points || points.length < 2) { this.toast('No road route there yet. Use “Jump there”.'); this.showDest(target, null); return; }
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
    let best = Infinity, bestI = 1, bestT = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const t = clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1);
      const d = Math.hypot(px - ax - vx * t, pz - az - vz * t);
      if (d < best) { best = d; bestI = i; bestT = t; }
    }
    let left = Math.hypot(pts[bestI][0] - pts[bestI - 1][0], pts[bestI][1] - pts[bestI - 1][1]) * (1 - bestT);
    for (let i = bestI + 1; i < pts.length; i++) left += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
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
    if (this.disposed || document.body.classList.contains('chat-open') || document.querySelector('dialog[open]') || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (this.root.querySelector('.roam-loading')) {
      if(k==='Escape' && e.type==='keydown'){e.preventDefault();e.stopPropagation();this.exit();}
      return;
    }
    const handled = ['w', 'a', 's', 'd', 'q', 'e', 'f', ' ', 'Shift', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'r', 'Escape', 'm', 'g', 'v', '1', '2', '3', 'c', 'h'].includes(k);
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
    else if (k === 'f' || (k === 'e' && this.mode !== 'drone')) {
      if (this.mode === 'car' || this.nearCar) this.useCar(); else if (this.mode === 'walk' && k === 'f') this.wave();
    }
    else if (k === 'h') { if (this.mode === 'walk') this.wave(); }
    else if (k === 'm') this.toggleBigMap();
    else if (k === 'g') this.togglePlaces();
    else if (k === '1') this.setMode('car');
    else if (k === '2') this.setMode('walk');
    else if (k === '3') this.setMode('drone');
    else if (k === 'v' || k === 'c') this.setMode(this.mode === 'car' ? 'walk' : this.mode === 'walk' ? 'drone' : 'car');
  };

  private wave() {
    if(!this.human || this.human.speed>=0.6)return;
    this.human.wave();
    const [x,z]=this.position();
    this.crowd?.greet(x,z);
  }

  private input() {
    const k = this.keys;
    let y = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
    let x = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
    if (this.stick.x || this.stick.y) { x = this.stick.x; y = this.stick.y; }
    if (this.autopilot && this.mode === 'car' && this.driving) [x, y] = this.drivePilot();
    const s = this.inputState;
    s.x = x; s.y = y;
    s.drift = k.has(' ') || this.touchButtons.has('drift');
    s.up = (this.mode === 'drone' && (k.has('e') || k.has(' '))) || this.touchButtons.has('up');
    s.down = (this.mode === 'drone' && (k.has('q') || k.has('Shift'))) || this.touchButtons.has('down');
    s.sprint = k.has('Shift') !== this.running;
    return s;
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
      b.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (name === 'reset') { if (this.mode === 'car') this.resetCar(); else this.jumpTo({ name: 'the road', ...this.nearestRoadXZ() }); }
        else if (name === 'run') { this.running = !this.running; b.setAttribute('aria-pressed', String(this.running)); }
        else if (name === 'wave') this.wave();
        else this.touchButtons.add(name);
      });
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(t, () => this.touchButtons.delete(name));
    });
  }

  /** Drag on the world to turn the camera when on foot or flying. */
  private mountLook() {
    const canvas = this.root.querySelector<HTMLCanvasElement>('.roam-canvas')!;
    let id = -1, lastX = 0;
    canvas.addEventListener('pointerdown', e => { if (this.mode === 'car') return; id = e.pointerId; lastX = e.clientX; canvas.setPointerCapture(id); });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      const d = (e.clientX - lastX) * 0.006; lastX = e.clientX;
      if (this.mode === 'drone') this.drone.h += d; else { this.dragYaw += d; this.dragUntil = performance.now() + 1800; }
    });
    const end = (e: PointerEvent) => { if (e.pointerId === id) id = -1; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  }

  private nearestRoadXZ() { const [x, z] = this.position(); const hit = this.stream.graph.nearest(x, z, 500); return { x: hit ? hit.point[0] : x, z: hit ? hit.point[1] : z }; }

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
    const paused = document.body.classList.contains('chat-open') || Boolean(document.querySelector('dialog[open]')) || !this.root.querySelector<HTMLElement>('.roam-onboard')!.hidden;
    const [px, pz] = this.position(), h = this.heading();
    this.stream.update(px, pz, Math.sin(h), -Math.cos(h));
    if (this.stream.graphVersion !== this.graphVersion) this.onGraphChanged();
    if (!paused) {
      if (this.seat > 0) this.seat -= dt;
      if (this.mode === 'car' && this.driving) this.driving.drive(this.seat > 0 ? 0 : input.y, input.x, input.drift, dt);
      else if (this.mode === 'walk') this.stepHuman(dt, input);
      else if (this.mode === 'drone') this.stepDrone(dt, input);
      this.stepTraffic(dt);
      // Fixed-step physics (60 Hz), at most three steps per frame.
      this.physAcc = Math.min(this.physAcc + dt, STEP * 3);
      while (this.physAcc >= STEP) { this.world.step(STEP); this.afterStep(STEP); this.physAcc -= STEP; }
      this.flushCrashes();
      if (this.mode === 'car') this.checkStuck(dt, input);
      if (this.driving && this.mode === 'car') this.crowd?.dodge(this.driving.x, this.driving.z, this.driving.speed);
    }
    for (const v of this.vehicles) v.sync(dt);
    for (const p of this.props) { p.mesh.position.set(p.body.position.x, p.body.position.y, p.body.position.z); p.mesh.quaternion.set(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w); }
    this.drawTraffic();
    this.stepSparks(dt);
    this.updateCamera(dt);
    this.ground.position.set(this.camLook.x, 0, this.camLook.z);
    if (this.crowd) this.crowd.update(paused ? 0 : dt, this.camLook.x, this.camLook.z);
    this.dynres?.update(dt);
    this.beaconTime += dt;
    for (const s of this.spots) if (s.beacon) {
      s.beacon.material.uniforms.time.value = this.beaconTime;
      s.beacon.material.uniforms.strength.value = s.kind === 'audio' && (s.live ?? 0) > 0 ? 1.4 : 0.85;
      s.beacon.ring.scale.setScalar(1 + 0.12 * Math.sin(this.beaconTime * 3 + s.x));
    }
    if (this.route) (this.route.mesh.material as THREE.ShaderMaterial).uniforms.time.value = this.beaconTime;
    this.players?.update(this.camera,dt);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    if (now > this.nextTick) {
      this.nextTick = now + 250;
      this.updateHud();
      this.root.querySelector<HTMLButtonElement>('.roam-chat')!.textContent = this.conversation().label;
      this.updateListening();
      this.drawMinimap();
      this.findNearCar();
      if (Math.hypot(px - this.spotsAt[0], pz - this.spotsAt[1]) > 700) void this.loadSpots();
      this.updateStats();
    } else if (this.fpsFrames.length % this.q.minimapEvery === 0) this.drawMinimap();
  }

  private updateStats() {
    const s = this.stats;
    s.fps = this.fpsFrames.length;
    s.mode = this.mode;
    s.speed = Math.round((this.driving?.speed ?? 0) * 3.6);
    s.dpr = Number((this.dynres?.ratio ?? 0).toFixed(2));
    s.pedsVisible = this.crowd?.visibleCount ?? 0;
    s.walker = this.human?.state ?? '-';
    s.chunks = this.stream.stats.chunks; s.built = this.stream.stats.built;
    s.buildMs = Number(this.stream.stats.lastBuildMs.toFixed(1)); s.maxBuildMs = Number(this.stream.stats.maxBuildMs.toFixed(1));
    s.bodies = this.world.bodies.length; s.vehicles = this.vehicles.length;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) s.heapMB = Math.round(mem.usedJSHeapSize / 1048576);
  }

  /** After each physics step: buildings, water and recovery for every free body. */
  private afterStep(dt: number) {
    for (const v of this.vehicles) this.collideBody(v.body, 1.0, 1.4, v);
    for (const t of this.traffic) if (t.body && t.crashed > 0) this.collideBody(t.body, 1.0, 1.4);
    for (const v of this.vehicles) this.waterVehicle(v, dt);
  }

  /** Building walls as simple 2D segments (no mesh colliders): two circles along the car. */
  private collideBody(body: CANNON.Body, r: number, off: number, v?: Vehicle) {
    const q = body.quaternion;
    const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y)), fl = Math.hypot(fx, fz) || 1;
    for (const o of [off, -off]) {
      const cx = body.position.x + fx / fl * o, cz = body.position.z + fz / fl * o;
      const hit = this.stream.pushOut(cx, cz, r, this.tmp.hit);
      if (!hit) continue;
      body.position.x += hit.dx; body.position.z += hit.dz;
      const vn = body.velocity.x * hit.nx + body.velocity.z * hit.nz;
      if (vn < 0) {
        body.velocity.x -= hit.nx * vn * 1.2; body.velocity.z -= hit.nz * vn * 1.2;
        body.velocity.x *= 0.85; body.velocity.z *= 0.85;
        if (v === this.driving) this.impact(-vn, cx - hit.nx * r, cz - hit.nz * r);
      }
    }
  }

  /** Water is a no-drive zone: slow cars meet the shore as a wall, fast ones splash, sink and respawn. */
  private waterVehicle(v: Vehicle, dt: number) {
    if (v.sinking > 0) {
      v.sinking += dt;
      v.body.velocity.scale(0.9, v.body.velocity);
      if (v.sinking > 2.6) {
        const s = this.stream.graph.spawnNear(v.x, v.z);
        if (v.driver === 'player' && s) { v.place(s.point[0], s.point[1], s.heading); this.toast('Back on the road'); }
        else this.removeVehicle(v);
      }
      return;
    }
    const depth = this.stream.waterDepth(v.x, v.z);
    if (depth < 0.4) { if (depth < 0) { v.lastDry.copy(v.body.position); } return; }
    if (v.speed > 7) {
      v.sinking = 0.001;
      this.burst(v.x, 0.4, v.z, 70, true);
      this.flash(0.35);
      if (v.driver === 'player') { this.toast('Splash!'); this.stats.splash = Number(this.stats.splash) + 1; }
    } else {
      v.body.position.x = v.lastDry.x; v.body.position.z = v.lastDry.z;
      v.body.velocity.scale(-0.25, v.body.velocity);
    }
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
    const v = this.driving;
    if (!v) return;
    // Forgiving: flipped or wedged cars come back to the road by themselves.
    v.tipped = v.upright < 0.45 ? v.tipped + dt : 0;
    if (v.tipped > 1.5) { this.resetCar(); this.toast('Back on your wheels'); return; }
    if (input.y !== 0 && v.speed < 0.8 && performance.now() - this.lastHit < 600) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 1.6 && this.stuck - dt <= 1.6) this.toast('Stuck? Press R (or Reset) to get back on the road');
    if (this.stuck > 3.5) { this.resetCar(); this.toast('Back on the road'); }
  }

  /** On foot with the animated character: camera-relative movement (Sketchbook style). */
  private stepHuman(dt: number, input: ReturnType<Roam['input']>) {
    const h = this.human, w = this.walker;
    if (!h) {
      const speed = (input.sprint ? 8.5 : 4.2) * input.y;
      w.h += input.x * 2.4 * dt; w.x += Math.sin(w.h) * speed * dt; w.z += -Math.cos(w.h) * speed * dt;
      const hit = this.stream.pushOut(w.x, w.z, 0.4, this.tmp.hit); if (hit) { w.x += hit.dx; w.z += hit.dz; }
      return;
    }
    // GTA-style follow: the camera swings behind you only for the forward part of the
    // stick. Side or back input keeps the camera still, so the walker runs straight across
    // or toward the screen instead of circling (camera chasing a camera-relative input).
    const push = Math.hypot(input.x, input.y), ahead = push > 0.1 ? Math.max(0, input.y / push) : 0;
    if (performance.now() > this.dragUntil && h.speed > 0.4 && ahead > 0) this.camYaw.target = this.camYaw.position + wrap(h.heading - this.camYaw.position) * ahead;
    this.camYaw.simulate(dt);
    if (this.dragYaw) { this.camYaw.reset(this.camYaw.position + this.dragYaw); this.dragYaw = 0; }
    const yaw = this.camYaw.position;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = Math.sin(yaw);
    h.depth = this.stream.waterDepth(h.x, h.z);
    const move = h.update(dt, fx * input.y + rx * input.x, fz * input.y + rz * input.x, input.sprint);
    h.x += move.dx; h.z += move.dz;
    const hit = this.stream.pushOut(h.x, h.z, 0.35, this.tmp.hit);
    if (hit) { h.x += hit.dx; h.z += hit.dz; }
    this.bumpWalker(h);
    h.sync();
    w.x = h.x; w.z = h.z; w.h = h.heading;
    this.stats.water = Number(h.depth.toFixed(1));
  }

  /** Cars are solid to someone on foot; a moving one knocks them over (stumble, then up again). */
  private bumpWalker(h: Walker) {
    const check = (bx: number, bz: number, heading: number, vx: number, vz: number) => {
      const c = Math.cos(heading), s = Math.sin(heading);
      const dx = h.x - bx, dz = h.z - bz;
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;                     // car-local: x right, z backward
      const ex = 1.0 + 0.35 - Math.abs(lx), ez = 2.35 + 0.35 - Math.abs(lz);
      if (ex <= 0 || ez <= 0) return;
      const speed = Math.hypot(vx, vz);
      if (speed > 3 && !h.down) { h.knockdown(dx + vx * 0.3, dz + vz * 0.3, speed); this.burst(h.x, 0.9, h.z, 6); this.stats.knockdowns = Number(this.stats.knockdowns ?? 0) + 1; return; }
      // Push out along the shallowest side (you cannot push a car).
      if (ex < ez) { const sx = Math.sign(lx) * ex; h.x += c * sx; h.z += s * sx; }
      else { const sz = Math.sign(lz) * ez; h.x += -s * sz; h.z += c * sz; }
    };
    for (const v of this.vehicles) check(v.x, v.z, v.heading, v.body.velocity.x, v.body.velocity.z);
    for (const t of this.traffic) {
      if (Math.abs(t.x - h.x) > 6 || Math.abs(t.z - h.z) > 6) continue;
      const moving = t.crashed > 0 && t.body ? [t.body.velocity.x, t.body.velocity.z] : [Math.sin(t.h) * t.speed, -Math.cos(t.h) * t.speed];
      check(t.x, t.z, t.h, moving[0], moving[1]);
    }
  }

  private stepDrone(dt: number, input: ReturnType<Roam['input']>) {
    const d = this.drone;
    const speed = 14 + d.alt * 0.45;
    d.h += input.x * 1.6 * dt;
    d.x += Math.sin(d.h) * speed * input.y * dt; d.z += -Math.cos(d.h) * speed * input.y * dt;
    d.alt = clamp(d.alt + ((input.up ? 1 : 0) - (input.down ? 1 : 0)) * 40 * dt, 18, 260);
  }

  private findNearCar() {
    const btn = this.root.querySelector<HTMLButtonElement>('.roam-enter')!;
    this.nearCar = undefined;
    if (this.mode === 'car') {
      btn.hidden = !this.touch; btn.textContent = 'Exit car';
      return;
    }
    if (this.mode !== 'walk') { btn.hidden = true; return; }
    const { x, z } = this.walker;
    let best = 3.6;
    for (const v of this.vehicles) { const d = Math.hypot(v.x - x, v.z - z); if (d < best && v.sinking === 0) { best = d; this.nearCar = v; } }
    for (const t of this.traffic) { const d = Math.hypot(t.x - x, t.z - z); if (d < best && t.sinking === 0) { best = d; this.nearCar = t; } }
    btn.hidden = !this.nearCar;
    btn.textContent = this.nearCar ? (this.touch ? 'Enter car' : 'F · Enter car') : '';
  }

  // ---------------------------------------------------------------- traffic
  private onGraphChanged() {
    this.graphVersion = this.stream.graphVersion;
    const g = this.stream.graph;
    // Re-snap every driving car onto the new road network.
    for (const t of this.traffic) {
      if (t.crashed > 0 || t.x > 1e5) continue;
      const hit = g.nearest(t.x, t.z, 30);
      if (!hit) { this.retireTraffic(t); continue; }
      const e = g.edges[hit.edge];
      const fwd = Math.sin(t.h) * (g.nodes[e.b][0] - g.nodes[e.a][0]) - Math.cos(t.h) * (g.nodes[e.b][1] - g.nodes[e.a][1]) >= 0;
      Object.assign(t, { edge: hit.edge, from: fwd ? e.a : e.b, t: (fwd ? hit.t : 1 - hit.t) * e.len });
    }
    const [x, z] = this.position();
    this.crowd?.setGraph(g, x, z, this.spots);
  }

  private retireTraffic(t: TrafficCar) {
    if (t.body) { this.world.removeBody(t.body); t.body = undefined; }
    Object.assign(t, { x: 1e6, z: 1e6, crashed: 0, still: 0, sinking: 0, speed: 0 });
  }

  private placeTraffic(all = false) {
    const g = this.stream.graph;
    if (!g.edges.length) return;
    const [px, pz] = this.position();
    const far = this.q.viewRadius * 0.95;
    for (const t of this.traffic) {
      if (!all && Math.hypot(t.x - px, t.z - pz) < far && t.crashed === 0) continue;
      if (t.crashed > 0 && Math.hypot(t.x - px, t.z - pz) < far) continue;
      if (t.body) { this.world.removeBody(t.body); t.body = undefined; }
      for (let tries = 0; tries < 40; tries++) {
        const ei = Math.floor(Math.random() * g.edges.length), e = g.edges[ei];
        const [ax, az] = g.nodes[e.a];
        const d = Math.hypot(ax - px, az - pz);
        if (d < (all ? 40 : 160) || d > far * 0.8 || e.cls === 'service') continue;
        Object.assign(t, { edge: ei, from: Math.random() < 0.5 ? e.a : e.b, t: Math.random() * e.len, crashed: 0, still: 0, sinking: 0,
          cruise: 7 + g.rank(e) * 1.6 + Math.random() * 3, speed: 6 });
        this.trafficPose(t); t.shown = t.h;
        break;
      }
    }
  }

  private trafficPose(t: TrafficCar) {
    const g = this.stream.graph, e = g.edges[t.edge];
    if (!e) return;
    const to = g.other(e, t.from);
    const [ax, az] = g.nodes[t.from], [bx, bz] = g.nodes[to];
    const ux = (bx - ax) / e.len, uz = (bz - az) / e.len;
    const lane = clamp(e.width / 4, 1.5, 3.4) * (this.driveLeft ? -1 : 1);
    t.x = ax + ux * t.t - uz * lane; t.z = az + uz * t.t + ux * lane;
    t.h = Math.atan2(ux, -uz);
  }

  private trafficBody(t: TrafficCar) {
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, allowSleep: false });
    body.addShape(new CANNON.Box(CAR.half), new CANNON.Vec3(0, 0.25, 0));
    // A crash with a moving body turns this car into a real, sliding rigid body (and can chain into a pile-up).
    body.addEventListener('collide', (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => {
      if (t.crashed > 0) return;
      const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
      // The hitter's velocity is read now, before the solver bounces it back.
      if (impact > 2.5 && e.body.type === CANNON.Body.DYNAMIC && e.body.mass > 50) this.pendingCrash.push({ t, vx: e.body.velocity.x, vz: e.body.velocity.z });
    });
    this.world.addBody(body);
    return body;
  }

  /** Convert queued traffic cars to dynamic bodies after the physics step (not inside it). */
  private flushCrashes() {
    for (const { t, vx, vz } of this.pendingCrash) {
      if (!t.body || t.crashed > 0) continue;
      const b = t.body;
      b.type = CANNON.Body.DYNAMIC; b.mass = CAR.mass; b.updateMassProperties();
      b.linearDamping = 0.3; b.angularDamping = 0.5;
      b.velocity.set(Math.sin(t.h) * t.speed, 0, -Math.cos(t.h) * t.speed);
      // Momentum from whatever hit it (equal masses, partly elastic): about 60% of the hitter's velocity.
      b.velocity.x += vx * 0.6; b.velocity.z += vz * 0.6;
      if (this.driving && Math.hypot(this.driving.x - t.x, this.driving.z - t.z) < 7) this.impact(Math.hypot(vx, vz), t.x, t.z, true);
      b.angularVelocity.set(0, (Math.random() - 0.5) * 3, 0);
      b.wakeUp();
      t.crashed = 0.001; t.still = 0;
      this.stats.crashes = Number(this.stats.crashes) + 1;
    }
    this.pendingCrash.length = 0;
  }

  private stepTraffic(dt: number) {
    const g = this.stream.graph;
    if (!g.edges.length) return;
    const [px, pz] = this.position();
    const physR = this.q.physicsRadius;
    for (const t of this.traffic) {
      if (t.x > 1e5) continue;
      const near = Math.hypot(t.x - px, t.z - pz) < physR;
      if (t.crashed > 0) {
        const b = t.body!;
        t.crashed += dt;
        t.x = b.position.x; t.z = b.position.z;
        const q = b.quaternion;
        t.h = Math.atan2(-2 * (q.x * q.z + q.w * q.y), (1 - 2 * (q.x * q.x + q.y * q.y)));
        t.shown = t.h;
        if (this.stream.waterDepth(t.x, t.z) > 0.4) { t.sinking += dt; if (t.sinking > 2) this.retireTraffic(t); continue; }
        t.still = b.velocity.length() < 0.6 ? t.still + dt : 0;
        if (t.still > 2.5 || t.crashed > 12) {
          // Rejoin the road and drive on (the driver is fine).
          const road = g.nearest(t.x, t.z, 40);
          if (!road) { this.retireTraffic(t); continue; }
          const e = g.edges[road.edge];
          const fwd = Math.sin(t.h) * (g.nodes[e.b][0] - g.nodes[e.a][0]) - Math.cos(t.h) * (g.nodes[e.b][1] - g.nodes[e.a][1]) >= 0;
          Object.assign(t, { edge: road.edge, from: fwd ? e.a : e.b, t: (fwd ? road.t : 1 - road.t) * e.len, speed: 0, crashed: 0, still: 0 });
          b.type = CANNON.Body.KINEMATIC; b.mass = 0; b.updateMassProperties(); b.velocity.setZero(); b.angularVelocity.setZero();
        }
        continue;
      }
      // Follow the road; slow for cars (and the player) ahead.
      let target = t.cruise;
      const fx = Math.sin(t.h), fz = -Math.cos(t.h);
      const ahead = (ox: number, oz: number) => {
        const rx = ox - t.x, rz = oz - t.z, along = rx * fx + rz * fz, side = Math.abs(rx * fz - rz * fx);
        if (along > 0 && along < 16 && side < 2.6) target = Math.min(target, Math.max(0, (along - 6) * 0.9));
      };
      for (const o of this.traffic) if (o !== t && o.x < 1e5) ahead(o.x, o.z);
      for (const v of this.vehicles) ahead(v.x, v.z);
      if (this.mode === 'walk') ahead(this.walker.x, this.walker.z);
      t.speed += clamp(target - t.speed, -9 * dt, 3 * dt);
      t.t += t.speed * dt;
      let e = g.edges[t.edge], guard = 0;
      while (e && t.t > e.len && guard++ < 8) {
        t.t -= e.len;
        const node = g.other(e, t.from);
        const [ax, az] = g.nodes[t.from], [nx, nz] = g.nodes[node];
        const dirx = (nx - ax) / e.len, dirz = (nz - az) / e.len;
        const options = g.adj[node].filter(i => i !== t.edge);
        let next = t.edge, best = -Infinity;
        for (const i of options) {
          const o = g.edges[i], [ox, oz] = g.nodes[g.other(o, node)], l = Math.hypot(ox - nx, oz - nz) || 1;
          const s = ((ox - nx) * dirx + (oz - nz) * dirz) / l + Math.random() * 0.9 + (o.cls === 'service' ? -0.6 : 0);
          if (s > best) { best = s; next = i; }
        }
        t.from = node; t.edge = next; e = g.edges[next];
      }
      this.trafficPose(t);
      t.shown += wrap(t.h - t.shown) * Math.min(1, dt * 8);
      // Kinematic body only near the player; far traffic is visuals only.
      if (near && !t.body) t.body = this.trafficBody(t);
      else if (!near && t.body) { this.world.removeBody(t.body); t.body = undefined; }
      if (t.body) {
        t.body.position.set(t.x, 0.65, t.z);
        t.body.quaternion.setFromEuler(0, -t.shown, 0);
        t.body.velocity.set(fx * t.speed, 0, fz * t.speed);
      }
    }
    if (Math.random() < dt * 2) this.placeTraffic();
  }

  private drawTraffic() {
    const { m, q, up, s: one, p } = this.tmp;
    this.traffic.forEach((t, i) => {
      if (t.crashed > 0 && t.body) {
        const b = t.body;
        q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        m.compose(p.set(b.position.x, b.position.y - 0.65 - t.sinking * 0.6, b.position.z), q, one);
      } else {
        q.setFromAxisAngle(up, -t.shown);
        m.compose(p.set(t.x, 0, t.z), q, one);
      }
      this.trafficMesh.body.setMatrixAt(i, m); this.trafficMesh.cabin.setMatrixAt(i, m); this.trafficMesh.lights.setMatrixAt(i, m);
    });
    for (const im of [this.trafficMesh.body, this.trafficMesh.cabin, this.trafficMesh.lights]) im.instanceMatrix.needsUpdate = true;
    if (this.trafficMesh.body.instanceColor) this.trafficMesh.body.instanceColor.needsUpdate = true;
  }

  /** Keep a few parked cars along nearby streets; cars far away are removed. */
  private manageParked() {
    const [px, pz] = this.position();
    for (const v of [...this.vehicles]) {
      if (v === this.driving) continue;
      if (Math.hypot(v.x - px, v.z - pz) > this.q.viewRadius) this.removeVehicle(v);
    }
    const parked = this.vehicles.filter(v => v !== this.driving).length;
    const roads = this.stream.roadsNear(px, pz, this.q.physicsRadius * 1.5).filter(r => r.drivable && r.width <= 9 && r.width >= 6.5);
    for (let i = parked; i < this.q.parked && roads.length; i++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      const k = Math.floor(Math.random() * (r.pts.length - 1));
      const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 8) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len, side = (r.width / 2 - 1.1) * (this.driveLeft ? -1 : 1);
      const x = (ax + bx) / 2 - uz * side, z = (az + bz) / 2 + ux * side;
      if (Math.hypot(x - px, z - pz) < 25 || this.stream.pushOut(x, z, 1.2, this.tmp.hit)) continue;
      const v = this.newVehicle(CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)], x, z, Math.atan2(ux, -uz));
      v.park();
    }
  }

  /** Cones and bins along big roads that react when hit (skipped on low-tier devices). */
  private manageProps() {
    if (!this.q.props) return;
    const [px, pz] = this.position();
    for (const p of [...this.props]) {
      if (Math.hypot(p.body.position.x - px, p.body.position.z - pz) < this.q.physicsRadius * 1.3) continue;
      this.world.removeBody(p.body); this.scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose();
      this.props.splice(this.props.indexOf(p), 1);
    }
    const max = this.q.tier === 'high' ? 24 : 12;
    const roads = this.stream.roadsNear(px, pz, this.q.physicsRadius).filter(r => r.drivable && r.width >= 9);
    for (let i = this.props.length; i < max && roads.length; i++) {
      const r = roads[Math.floor(Math.random() * roads.length)];
      const k = Math.floor(Math.random() * (r.pts.length - 1));
      const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1], len = Math.hypot(bx - ax, bz - az) || 1;
      const t = Math.random(), side = (r.width / 2 + 0.6) * (Math.random() < 0.5 ? 1 : -1);
      const x = ax + (bx - ax) * t - (bz - az) / len * side, z = az + (bz - az) * t + (bx - ax) / len * side;
      if (Math.hypot(x - px, z - pz) < 20 || this.stream.pushOut(x, z, 0.5, this.tmp.hit)) continue;
      const cone = Math.random() < 0.6;
      const size = cone ? new CANNON.Vec3(0.22, 0.38, 0.22) : new CANNON.Vec3(0.32, 0.5, 0.32);
      const body = new CANNON.Body({ mass: cone ? 3 : 8, linearDamping: 0.3, angularDamping: 0.3, allowSleep: true, sleepSpeedLimit: 0.2 });
      body.addShape(new CANNON.Box(size));
      body.position.set(x, size.y, z);
      this.world.addBody(body);
      const mesh = new THREE.Mesh(cone ? new THREE.ConeGeometry(0.26, 0.76, 10) : new THREE.CylinderGeometry(0.3, 0.26, 1, 10),
        new THREE.MeshLambertMaterial({ color: cone ? 0xff8a3d : 0x3c4a43 }));
      this.scene.add(mesh);
      this.props.push({ body, mesh });
    }
  }

  // ---------------------------------------------------------------- effects
  private burst(x: number, y: number, z: number, n: number, water = false) {
    const pos = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    (this.sparks.material as THREE.PointsMaterial).color.setHex(water ? 0xbfe8f2 : 0xffc56b);
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * pos.count);
      pos.setXYZ(i, x + (Math.random() - 0.5) * (water ? 3 : 0.5), y, z + (Math.random() - 0.5) * (water ? 3 : 0.5));
      this.sparkLife[i] = { vx: (Math.random() - 0.5) * (water ? 5 : 9), vy: Math.random() * (water ? 9 : 6) + 1, vz: (Math.random() - 0.5) * (water ? 5 : 9), life: 0.5 + Math.random() * 0.5 };
    }
  }

  private stepSparks(dt: number) {
    const pos = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    let any = false;
    for (let i = 0; i < this.sparkLife.length; i++) {
      const s = this.sparkLife[i];
      if (!s || s.life <= 0) continue;
      any = true;
      s.life -= dt; s.vy -= 18 * dt;
      pos.setXYZ(i, pos.getX(i) + s.vx * dt, Math.max(0.05, pos.getY(i) + s.vy * dt), pos.getZ(i) + s.vz * dt);
      if (s.life <= 0) pos.setXYZ(i, 0, -50, 0);
    }
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

  private snapCamera() { this.updateCamera(1, true); }

  /**
   * Car: chase camera with the racing-game offset (sideways with steering x speed,
   * further back with speed). On foot: behind the camera yaw spring. Drone: orbit
   * from above. The camera eases between them, so getting in and out is smooth.
   */
  private updateCamera(dt: number, snap = false) {
    const [x, z] = this.position(), h = this.heading();
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const want = this.tmp.want, look = this.tmp.look;
    let rate = 6;
    if (this.mode === 'car' && this.driving) {
      const v = this.driving, speed = v.speed;
      const side = Math.sin(-v.steering) * speed / 2.5 * 0.35, back = 7.5 + speed / 15, up = 2.8 + speed * 0.02;
      want.set(x - fx * back + rx * side, up, z - fz * back + rz * side);
      look.set(x + fx * 5, 1.1, z + fz * 5);
      this.camera.fov += (62 + speed * 0.3 - this.camera.fov) * Math.min(1, dt * 3);
      rate = this.seat > 0 ? 3 : 6;
    } else if (this.mode === 'walk') {
      const yaw = this.human ? this.camYaw.position : h, cx = Math.sin(yaw), cz = -Math.cos(yaw);
      const swim = this.human?.state === 'swim' ? -0.8 : 0;
      want.set(x - cx * 4.6, 2.3 + swim, z - cz * 4.6);
      look.set(x + cx * 1.5, 1.35 + swim, z + cz * 1.5);
      this.camera.fov += (60 - this.camera.fov) * Math.min(1, dt * 3);
      rate = 4;
    } else {
      const a = this.drone.alt;
      want.set(x - fx * a * 0.75, a, z - fz * a * 0.75);
      look.set(x, 0, z);
      this.camera.fov += (55 - this.camera.fov) * Math.min(1, dt * 3);
      rate = 4;
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * rate);
    this.camPos.lerp(want, k); this.camLook.lerp(look, k);
    const cam = this.camera.position.copy(this.camPos), aim = this.camAim.copy(this.camLook);
    if (this.mode !== 'drone') {
      // Swing around the player, never through them, when the heading flips (a spin after a crash).
      const reach = Math.hypot(want.x - x, want.z - z), ox = this.camPos.x - x, oz = this.camPos.z - z, d = Math.hypot(ox, oz);
      if (d < reach * 0.35) {
        const s = reach * 0.35 / (d > 0.01 ? d : 1), bx = d > 0.01 ? ox : want.x - x, bz = d > 0.01 ? oz : want.z - z;
        this.camPos.x = x + bx * s; this.camPos.z = z + bz * s;
      }
      // Spring arm (as in game engines' third-person cameras): a wall between the player and
      // the camera pulls the camera in front of it at once; when the view clears, the arm eases
      // back out. The smoothed camPos stays where it wants to be, so a wall never drags the
      // camera aside or traps it behind a building.
      const len = Math.hypot(this.camPos.x - x, this.camPos.z - z);
      const t = len > 0.5 ? this.stream.rayWall(x, z, this.camPos.x, this.camPos.z) : 1;
      const fit = t < 1 ? clamp((t * len - 0.45) / len, 0.08, 1) : 1;
      this.camArm = snap || fit < this.camArm ? fit : this.camArm + (fit - this.camArm) * (1 - Math.exp(-dt * 2.5));
      // Pulled in close, look further ahead over the player's head instead of down at them.
      const pull = 1 - this.camArm, ux = (this.camPos.x - x) / (len || 1), uz = (this.camPos.z - z) / (len || 1);
      cam.set(x + ux * len * this.camArm, this.camPos.y + pull * 0.4, z + uz * len * this.camArm);
      aim.x -= ux * pull * 3; aim.z -= uz * pull * 3;
      const hit = this.stream.pushOut(cam.x, cam.z, 0.3, this.tmp.hit);
      if (hit) { cam.x += hit.dx; cam.z += hit.dz; }
    }
    if (this.shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake *= Math.exp(-dt * 7);
    }
    this.camera.lookAt(aim);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- HUD
  private updateHud() {
    const box = this.root.querySelector<HTMLElement>('.roam-speed')!;
    const b = box.querySelector('b')!, small = box.querySelector('small')!, bar = box.querySelector<HTMLElement>('s')!;
    if (this.mode === 'car') { const speed = Math.round((this.driving?.speed ?? 0) * 3.6); b.textContent = String(speed); small.textContent = 'km/h'; bar.style.width = Math.min(100, speed / 1.1) + '%'; }
    else if (this.mode === 'walk') {
      const st = this.human?.state ?? 'walk';
      b.textContent = st === 'swim' ? 'Swimming' : 'On foot';
      small.textContent = ({ run: 'running', idle: 'standing', wave: 'waving', down: 'oof!', wade: 'wading', swim: 'in the water' } as Record<string, string>)[st] ?? 'walking';
      bar.style.width = this.human ? Math.min(100, this.human.speed / 6.2 * 100) + '%' : '0';
    } else { b.textContent = Math.round(this.drone.alt) + ' m'; small.textContent = 'drone altitude'; bar.style.width = Math.min(100, this.drone.alt / 2.6) + '%'; }
    const [x, z] = this.position();
    const name = this.stream.streetName(x, z);
    const street = this.root.querySelector<HTMLElement>('.roam-street')!;
    street.querySelector('span')!.textContent = name;
    street.classList.toggle('on', Boolean(name));
    // Light hint at the edge of what has streamed in, instead of a wall.
    this.root.querySelector<HTMLElement>('.roam-loading-hint')!.hidden = this.stream.ready(x + Math.sin(this.heading()) * 120, z - Math.cos(this.heading()) * 120) || !this.stream.stats.loading && this.stream.ready(x, z);
    this.updateDest();
    if (this.route && this.routeRemaining() < 22) { const n = this.route.target.name; this.clearRoute(); this.toast('You are here: ' + n); }
  }

  private updateLabels() {
    const [px, pz] = this.position();
    const v = this.tmp.v;
    const far = this.mode === 'drone' ? 1400 : this.q.labelsFar;
    const w = innerWidth, h = innerHeight;
    const taken: number[] = [];
    const order = this.spots.map(s => ({ s, d: Math.hypot(s.x - px, s.z - pz) })).sort((a, b) => (a.s.kind === 'landmark' ? 1 : 0) - (b.s.kind === 'landmark' ? 1 : 0) || a.d - b.d);
    for (const { s, d } of order) {
      if (!s.label) continue;
      v.set(s.x, s.kind === 'audio' ? 9 : 7, s.z).project(this.camera);
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      let visible = d < far && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      if (visible) for (let i = 0; i < taken.length; i += 2) if (Math.abs(taken[i] - sx) < 150 && Math.abs(taken[i + 1] - sy) < 46) { visible = false; break; }
      s.label.style.display = visible ? '' : 'none';
      if (!visible) continue;
      taken.push(sx, sy);
      s.label.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      s.label.style.opacity = String(clamp(1.25 - d / far, 0.35, 1));
      s.label.style.zIndex = String(Math.round(2000 - d));
      s.label.querySelector('small')!.textContent = fmtDist(d);
    }
  }

  /** Mini-map from the streamed chunk tiles: heading-up and close; the big map is north-up. */
  private drawMinimap(big = false) {
    const canvas = big ? this.root.querySelector<HTMLCanvasElement>('.roam-bigmap canvas')! : this.minimap;
    const dpr = Math.min(2, devicePixelRatio);
    const cssW = canvas.clientWidth || 200, cssH = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(cssW * dpr)) { canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr); }
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    const [px, pz] = this.position(), h = this.heading();
    const range = big ? this.q.viewRadius * 1.3 : this.mode === 'drone' ? 320 : 170;
    const scale = Math.min(W, H) / (range * 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#16181b'; g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    if (!big) g.rotate(-h);
    g.scale(scale, scale);
    g.translate(-px, -pz);
    const s = this.stream.mapScale;
    for (const tile of this.stream.tiles(px, pz, range * 1.5)) g.drawImage(tile.canvas, tile.x, tile.z, tile.canvas.width / s, tile.canvas.height / s);
    if (this.route) {
      g.strokeStyle = '#f5bd52'; g.lineWidth = 5 * dpr / scale / 2; g.lineJoin = 'round';
      g.beginPath(); this.route.points.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
    }
    g.fillStyle = '#9da3a8';
    for (const t of this.traffic) if (t.x < 1e5) { g.beginPath(); g.arc(t.x, t.z, 2.2 * dpr / scale / 2, 0, Math.PI * 2); g.fill(); }
    for (const v of this.vehicles) if (v !== this.driving) { g.fillStyle = '#' + v.color.toString(16).padStart(6, '0'); g.beginPath(); g.arc(v.x, v.z, 2.6 * dpr / scale / 2, 0, Math.PI * 2); g.fill(); }
    for (const p of this.players?.avatars.values() ?? []) {
      g.fillStyle = '#90f5d7'; g.beginPath(); g.arc(p.x,p.z,4*dpr/scale,0,Math.PI*2); g.fill();
    }
    for (const sp of this.spots) {
      const pulse = sp.kind === 'audio' && (sp.live ?? 0) > 0 ? 1 + 0.35 * Math.sin(this.beaconTime * 5) : 1;
      g.fillStyle = '#' + sp.color.toString(16).padStart(6, '0');
      g.beginPath(); g.arc(sp.x, sp.z, (sp.kind === 'landmark' ? 2.6 : 4.4) * pulse * dpr / scale / 2, 0, Math.PI * 2); g.fill();
      if (big) { g.fillStyle = '#efe9dc'; g.font = `${11 * dpr / scale / 2}px Geist, sans-serif`; g.fillText(sp.name.slice(0, 26), sp.x + 7 * dpr / scale / 2, sp.z + 4 * dpr / scale / 2); }
    }
    g.restore();
    g.save();
    g.translate(W / 2, H / 2);
    if (big) g.rotate(h);
    const a = 9 * dpr;
    g.fillStyle = this.mode === 'walk' ? '#b4ffe6' : '#f5bd52'; g.strokeStyle = '#111'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(0, -a); g.lineTo(a * 0.72, a * 0.8); g.lineTo(0, a * 0.35); g.lineTo(-a * 0.72, a * 0.8); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  private onMapClick(canvas: HTMLCanvasElement, e: MouseEvent, big: boolean) {
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    let x = (e.clientX - r.left) * k - canvas.width / 2, y = (e.clientY - r.top) * k - canvas.height / 2;
    const range = big ? this.q.viewRadius * 1.3 : this.mode === 'drone' ? 320 : 170;
    const scale = Math.min(canvas.width, canvas.height) / (range * 2);
    if (!big) { const h = this.heading(), c = Math.cos(h), s = Math.sin(h); [x, y] = [x * c - y * s, x * s + y * c]; }
    const [px, pz] = this.position();
    const wx = px + x / scale, wz = pz + y / scale;
    const near = this.spots.map(s => ({ s, d: Math.hypot(s.x - wx, s.z - wz) })).sort((a, b) => a.d - b.d)[0];
    const target = near && near.d < 18 * k / scale ? near.s : { name: 'Map point', x: wx, z: wz };
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
         <li><b>On foot</b><span>The stick walks you, Run toggles jogging, Wave waves; drag the view to look around</span></li>
         <li><b>Cars</b><span>Walk up to any car and tap Enter car; tap Exit car to get out</span></li>`
      : `<li><b>Drive</b><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows · <kbd>Space</kbd> drift · <kbd>R</kbd> back on the road</span></li>
         <li><b>Cars</b><span>Walk up to any car and press <kbd>F</kbd> to take it; <kbd>F</kbd> again to get out</span></li>
         <li><b>Explore</b><span><kbd>1</kbd> car · <kbd>2</kbd> walk (<kbd>Shift</kbd> run, <kbd>H</kbd> wave, drag to look) · <kbd>3</kbd> drone (<kbd>E</kbd>/<kbd>Q</kbd>)</span></li>
         <li><b>Find</b><span><kbd>G</kbd> places · <kbd>M</kbd> big map · <kbd>Esc</kbd> back to the map</span></li>`;
    box.innerHTML = `<div class="roam-onboard-card">
        <span class="roam-kicker">Free roam · ${esc(this.options.place?.locality ?? 'your area')}</span>
        <h2>Explore your neighbourhood</h2>
        <p>Real streets and buildings, streamed from the map as you go. Drive, walk or fly a drone. Glowing columns mark places: activities, rooms, events and live audio.</p>
        <ul>${keys}
          <li><b>Meet people</b><span>Invite a friend to your virtual spot. Within 60 m, tap their name to call. Other players see your avatar here.</span></li>
          <li><b>Go places</b><span>Tap the mini-map or open Places to get a route, or jump straight there</span></li>
          <li><b>Live audio</b><span>Get within ${LISTEN_RADIUS} m of a pink column to listen in; the people talking can see you are listening</span></li></ul>
        <button type="button">Start exploring</button>
        <p class="roam-credits">Character “Business Man” by Quaternius (CC0) · movement from Sketchbook by swift502 (MIT) · car handling from pmndrs/racing-game (MIT) and folio-2019 by Bruno Simon (MIT) · physics by cannon-es (MIT) · map data © OpenStreetMap contributors</p>
      </div>`;
    box.querySelector('button')!.onclick = () => this.onboarding(false);
  }

  private conversation() {
    const [x,z] = this.position();
    let closest: Spot | undefined;
    let distance = LISTEN_RADIUS;
    for (const spot of this.spots) {
      if (!spot.id.startsWith('c:')) continue;
      const d = Math.hypot(spot.x-x,spot.z-z);
      if (d < distance) { closest = spot; distance = d; }
    }
    if (closest) return {id:closest.id.slice(2), title:closest.name, kind:KIND_LABEL[closest.kind] || 'Chat room', label:'Chat · ' + closest.name};
    // A shared virtual block (roughly 110 m north/south). Only the coarse
    // avatar block is used for channel routing, never device coordinates.
    const [lng,lat] = this.frame.toLngLat(x,z);
    return {id:'roam_' + Math.floor((lng+180)*1000) + '_' + Math.floor((lat+90)*1000),
      title:'Nearby in Free Roam', kind:'Block chat', label:'Talk nearby'};
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
    const prompt = this.root.querySelector<HTMLElement>('.roam-live')!;
    if (!nearest || nearest.d >= LISTEN_RADIUS || this.muteUntilOutside.has(nearest.s.id)) {
      prompt.hidden = true;
      delete prompt.dataset.invite;
      return;
    }
    prompt.hidden = false;
    if (prompt.dataset.invite === nearest.s.id) return;
    prompt.dataset.invite = nearest.s.id;
    prompt.innerHTML = '<header><b></b></header><div class="roam-live-actions"><button type="button">Listen in</button></div>';
    prompt.querySelector('b')!.textContent = nearest.s.name;
    prompt.querySelector('button')!.onclick = () => {
      if (!this.joining) { delete prompt.dataset.invite; void this.listen(nearest.s); }
    };
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

  private drivePilot(): [number, number] {
    const a = this.autopilot!, v = this.driving!;
    const next = () => {
      // A new destination about 1.5 km further on, roughly keeping the direction.
      a.dir += (Math.random() - 0.5) * 1.2;
      const pts = this.stream.graph.route([v.x, v.z], [v.x + Math.sin(a.dir) * 1500, v.z - Math.cos(a.dir) * 1500]);
      a.points = pts ?? []; a.i = 0;
    };
    if (!a.points.length) next();
    while (a.i < a.points.length && Math.hypot(a.points[a.i][0] - v.x, a.points[a.i][1] - v.z) < 14) a.i++;
    if (a.i >= a.points.length) { next(); return [0, 0.5]; }
    // Stuck against something: back out with the wheel turned, then plan again.
    if (a.back > 0) { a.back -= 1 / 60; if (a.back <= 0) next(); return [1, -1]; }
    a.slow = v.speed < 1 ? a.slow + 1 / 60 : 0;
    if (a.slow > 1.5) { a.slow = 0; a.back = 1.2; return [1, -1]; }
    if (a.i >= a.points.length) return [0, 0];
    const [tx, tz] = a.points[a.i];
    const angle = wrap(Math.atan2(tx - v.x, -(tz - v.z)) - v.heading);
    // Like a careful driver: fast on straights, slow into corners.
    const ahead = a.points[Math.min(a.points.length - 1, a.i + 3)];
    const turn = Math.abs(wrap(Math.atan2(ahead[0] - tx, -(ahead[1] - tz)) - v.heading));
    const want = Math.abs(angle) > 0.6 || turn > 0.9 ? 7 : turn > 0.45 ? 13 : 24;
    return [clamp(angle * 2.2, -1, 1), v.speed < want ? 1 : v.speed > want + 3 ? -0.7 : 0];
  }

  // ---------------------------------------------------------------- test hooks (?roamdebug)
  private debugHooks() {
    return {
      teleport: (x: number, z: number) => {
        this.stream.buildAround(x, z);
        this.drone.x = this.walker.x = x; this.drone.z = this.walker.z = z; this.human?.place(x, z, this.walker.h);
        if (this.driving) { const s = this.stream.graph.spawnNear(x, z); this.driving.place(s?.point[0] ?? x, s?.point[1] ?? z, s?.heading ?? 0); }
        this.snapCamera();
      },
      place: (x: number, z: number, heading: number) => { this.driving?.place(x, z, heading); this.walker = { x, z, h: heading }; this.human?.place(x, z, heading); this.snapCamera(); },
      spots: () => this.spots.map(sp => ({ id: sp.id, name: sp.name, kind: sp.kind, x: sp.x, z: sp.z, live: sp.live })),
      position: () => this.position(),
      /** Camera spring arm: length 0..1 and whether a wall hides the player. */
      camera: () => { const [x, z] = this.position(), c = this.camera.position; return { arm: Number(this.camArm.toFixed(2)), clear: this.stream.rayWall(x, z, c.x, c.z) === 1, dist: Number(Math.hypot(c.x - x, c.z - z).toFixed(2)) }; },
      /** Player car heading, speed and slide angle (degrees between nose and travel). */
      car: () => { const v = this.driving; if (!v) return null; const s = Math.atan2(v.body.velocity.x, -v.body.velocity.z) - v.heading; return { heading: v.heading, speed: v.speed, slip: v.speed > 1 ? Math.round(Math.abs(Math.atan2(Math.sin(s), Math.cos(s))) * 180 / Math.PI) : 0, upright: v.upright }; },
      /** On foot with your back to the nearest wall (tests the camera against walls). */
      backToWall: () => {
        this.setMode('walk');
        const [x, z] = this.position();
        let best: { h: number; d: number } | null = null;
        for (let a = 0; a < 72; a++) {
          const h = a / 72 * Math.PI * 2, t = this.stream.rayWall(x, z, x + Math.sin(h) * 40, z - Math.cos(h) * 40);
          if (t < 1 && (!best || t * 40 < best.d)) best = { h, d: t * 40 };
        }
        if (!best) return false;
        const d = best.d - 0.5, h = best.h + Math.PI;
        const wx = x + Math.sin(best.h) * d, wz = z - Math.cos(best.h) * d;
        this.walker = { x: wx, z: wz, h }; this.human?.place(wx, wz, h); this.camYaw.reset(h);
        return { wallAt: Number(best.d.toFixed(1)) };
      },
      pilotState: () => { const a = this.autopilot, v = this.driving; return a && v ? { n: a.points.length, i: a.i, target: a.points[a.i]?.map(Math.round), car: [Math.round(v.x), Math.round(v.z)], heading: v.heading.toFixed(2), speed: v.speed.toFixed(1), upright: v.upright.toFixed(2), y: v.body.position.y.toFixed(2), sleeping: v.body.sleepState } : null; },
      autopilot: (on: boolean) => { this.autopilot = on ? { points: [], i: 0, slow: 0, dir: this.heading(), back: 0 } : undefined; return on; },
      /** Put the car on the nearest big road (trunk/primary/secondary), facing along it. */
      toMainRoad: () => {
        const g = this.stream.graph, [x, z] = this.position();
        let best = -1, bd = Infinity;
        g.edges.forEach((e, i) => {
          if (!['motorway', 'trunk', 'primary', 'secondary'].includes(e.cls) || e.len < 20) return;
          const [ax, az] = g.nodes[e.a], d = Math.hypot(ax - x, az - z);
          if (d < bd) { bd = d; best = i; }
        });
        if (best < 0) return false;
        const e = g.edges[best], [ax, az] = g.nodes[e.a], [bx, bz] = g.nodes[e.b];
        const h = Math.atan2(bx - ax, -(bz - az));
        this.stream.buildAround((ax + bx) / 2, (az + bz) / 2);
        this.driving?.place((ax + bx) / 2, (az + bz) / 2, h);
        this.snapCamera();
        return { cls: e.cls, distance: Math.round(bd) };
      },
      quality: () => ({ ...this.q }),
      pedestrians: () => this.crowd?.snapshot() ?? [],
      /** Three stopped traffic cars in a line ahead of the player's car. */
      lineUp: () => {
        const v = this.driving; if (!v) return false;
        const h = v.heading, fx = Math.sin(h), fz = -Math.cos(h);
        this.traffic.slice(0, 3).forEach((t, i) => {
          if (t.body) { this.world.removeBody(t.body); t.body = undefined; }
          Object.assign(t, { x: v.x + fx * (22 + i * 5.2), z: v.z + fz * (22 + i * 5.2), h, shown: h, cruise: 0, speed: 0, crashed: 0, still: 0, sinking: 0 });
          t.body = this.trafficBody(t);
          t.body.position.set(t.x, 0.65, t.z); t.body.quaternion.setFromEuler(0, -h, 0);
        });
        // Freeze them in place until hit: give them an edge that ends nowhere.
        this.traffic.slice(0, 3).forEach(t => { t.edge = -1 as unknown as number; });
        return true;
      },
      /** Nearest water edge: place the car facing it from about 40 m away on land. */
      aimAtWater: () => {
        let best: { x: number; z: number; d: number } | null = null;
        const [px, pz] = this.position();
        for (let a = 0; a < 64; a++) for (let r = 20; r < 900; r += 15) {
          const x = px + Math.cos(a / 64 * Math.PI * 2) * r, z = pz + Math.sin(a / 64 * Math.PI * 2) * r;
          if (this.stream.waterDepth(x, z) > 6) { if (!best || r < best.d) best = { x, z, d: r }; break; }
        }
        if (!best) return false;
        const h = Math.atan2(best.x - px, -(best.z - pz)), fx = Math.sin(h), fz = -Math.cos(h);
        let x = best.x, z = best.z;
        for (let s = 0; s < 120 && this.stream.waterDepth(x, z) >= 0; s++) { x -= fx * 2; z -= fz * 2; }
        x -= fx * 40; z -= fz * 40;
        this.stream.buildAround(x, z);
        this.driving?.place(x, z, h); this.walker = { x, z, h }; this.human?.place(x, z, h);
        this.snapCamera();
        return { x, z, h, waterAt: best };
      },
      nearestTraffic: () => { const [x, z] = this.position(); return this.traffic.filter(t => t.x < 1e5).map(t => ({ x: t.x, z: t.z, d: Math.hypot(t.x - x, t.z - z) })).sort((a, b) => a.d - b.d)[0]; },
      walkTo: (x: number, z: number) => { this.walker.x = x; this.walker.z = z; this.human?.place(x, z, this.walker.h); },
      /** Roll the nearest parked car at the walker (tests the knockdown). */
      rollCarAtWalker: () => {
        const { x, z } = this.walker;
        const v = this.vehicles.filter(o => o !== this.driving).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
        if (!v) return false;
        const h = this.walker.h + Math.PI;
        v.place(x - Math.sin(h) * -10, z + Math.cos(h) * -10, h);
        for (let i = 0; i < 4; i++) v.raycast.setBrake(0, i);
        v.body.velocity.set((x - v.x) / 10 * 9, 0, (z - v.z) / 10 * 9);
        return true;
      },
    };
  }
}

