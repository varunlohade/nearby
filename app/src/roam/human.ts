// Animated people for Free Roam: the player on foot and a few pedestrians.
//
// Model: "Business Man" by Quaternius, CC0 1.0 (poly.pizza/m/JFrLIKqvCH),
// trimmed to Idle, Walk, Run, Wave and Interact and meshopt-compressed
// (public/models/human.glb, see public/models/README.md).
//
// Movement follows Sketchbook's character controller (github.com/swift502/Sketchbook,
// MIT): a velocity spring toward the camera-relative input direction and a
// rotation spring that turns the body toward where it is going. Animation blends
// idle, walk and run by speed, with playback speed matched to ground speed so
// the feet do not slide.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { RoadGraph } from './graph';
import { RelativeSpring, VectorSpring } from './springs';

const HEIGHT = 1.75;
export const WALK_SPEED = 2.0;   // m/s, brisk walk
export const RUN_SPEED = 6.2;    // m/s, jog

export interface HumanAsset {
  scene: THREE.Object3D;
  clips: Record<string, THREE.AnimationClip>;
  /** Ground speed (m/s) of each locomotion clip at timeScale 1, measured from the feet. */
  natural: { Walk: number; Run: number };
}

let pending: Promise<HumanAsset> | undefined;

/** Load the character once, only when Free Roam opens. */
export function loadHuman(): Promise<HumanAsset> {
  pending ??= (async () => {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/models/human.glb');
    const model = gltf.scene;
    model.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.frustumCulled = false; (o as THREE.Mesh).castShadow = false; } });
    // Normalise to 1.75 m with the feet on the ground, facing -z (our forward).
    const box = new THREE.Box3().setFromObject(model);
    const scale = HEIGHT / Math.max(0.01, box.max.y - box.min.y);
    const holder = new THREE.Group();
    model.scale.multiplyScalar(scale);
    model.position.y = -box.min.y * scale;
    model.rotation.y = Math.PI;
    holder.add(model);
    const clips = Object.fromEntries(gltf.animations.map(c => [c.name, c]));
    const natural = { Walk: measure(holder, clips.Walk) || 1.6, Run: measure(holder, clips.Run) || 4.8 };
    return { scene: holder, clips, natural };
  })();
  return pending;
}

/** Speed of the planted foot during a cycle: the ground speed the clip was animated for. */
function measure(holder: THREE.Object3D, clip?: THREE.AnimationClip) {
  if (!clip) return 0;
  const probe = cloneSkinned(holder);
  const mixer = new THREE.AnimationMixer(probe);
  mixer.clipAction(clip).play();
  const feet = ['Foot.L', 'Foot.R'].map(n => probe.getObjectByName(n)).filter(Boolean) as THREE.Object3D[];
  if (!feet.length) return 0;
  const samples: { y: number; z: number }[][] = feet.map(() => []);
  const n = 48, v = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    mixer.setTime((clip.duration * i) / n);
    probe.updateMatrixWorld(true);
    feet.forEach((f, k) => { f.getWorldPosition(v); samples[k].push({ y: v.y, z: v.z }); });
  }
  const speeds: number[] = [];
  for (const s of samples) {
    const minY = Math.min(...s.map(p => p.y)), maxY = Math.max(...s.map(p => p.y));
    for (let i = 1; i < s.length; i++) {
      if (s[i].y > minY + (maxY - minY) * 0.12) continue; // foot on the ground
      speeds.push(Math.abs(s[i].z - s[i - 1].z) / (clip.duration / n));
    }
  }
  mixer.stopAllAction();
  speeds.sort((a, b) => a - b);
  return speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
}

/** A character instance: model clone, mixer and the four actions we blend. */
class Body {
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  readonly idle: THREE.AnimationAction;
  readonly walk: THREE.AnimationAction;
  readonly run: THREE.AnimationAction;
  readonly wave?: THREE.AnimationAction;
  readonly interact?: THREE.AnimationAction;
  readonly hit?: THREE.AnimationAction;
  /** Swimming: arms keep stroking (run cycle, slowed) and the body sits low in the water. */
  swimming = false;
  private readonly model: THREE.Object3D;
  private gesture?: THREE.AnimationAction;
  private gestureLeft = 0;

  constructor(private asset: HumanAsset, tint?: Tint) {
    const model = cloneSkinned(asset.scene);
    if (tint) applyTint(model, tint);
    this.root.add(model);
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    const act = (name: string) => asset.clips[name] ? this.mixer.clipAction(asset.clips[name]) : undefined;
    this.idle = act('Idle')!; this.walk = act('Walk')!; this.run = act('Run')!;
    this.wave = act('Wave'); this.interact = act('Interact'); this.hit = act('Hit');
    for (const a of [this.idle, this.walk, this.run]) { a.play(); a.setEffectiveWeight(0); }
    this.idle.setEffectiveWeight(1);
    for (const a of [this.wave, this.interact, this.hit]) if (a) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; }
  }

  get gesturing() { return this.gestureLeft > 0; }

  /** Play a one-shot gesture (wave) over the current pose. */
  gestureOnce(action = this.wave) {
    if (!action || this.gestureLeft > 0) return;
    this.gesture = action;
    action.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    this.gestureLeft = action.getClip().duration;
  }

  /** A cartoon stumble (no ragdoll): the hit reaction, then back to normal. */
  stumble() { this.gestureLeft = 0; this.gestureOnce(this.hit); }

  /** Blend idle, walk and run by ground speed; match playback to speed. */
  blend(speed: number, dt: number, depth = 0) {
    const { Walk: wn, Run: rn } = this.asset.natural;
    let wi = 0, ww = 0, wr = 0;
    // Wading lowers the body a little; swimming sinks it to the shoulders.
    const sink = this.swimming ? 1.15 : Math.min(0.45, Math.max(0, depth) * 0.3);
    this.model.position.y += (-sink - this.model.position.y) * Math.min(1, dt * 4); // holder clone rests at y = 0
    if (this.swimming) { wr = 1; this.run.timeScale = 0.45; this.idle.setEffectiveWeight(0); this.walk.setEffectiveWeight(0); this.run.setEffectiveWeight(1); this.mixer.update(dt); return; }
    if (speed < 0.12) wi = 1;
    else if (speed < WALK_SPEED) { const t = speed / WALK_SPEED; wi = 1 - t; ww = t; }
    else { const t = Math.min(1, (speed - WALK_SPEED) / (RUN_SPEED * 0.7 - WALK_SPEED)); ww = 1 - t; wr = t; }
    if (this.gestureLeft > 0) {
      this.gestureLeft -= dt;
      const fade = Math.min(1, this.gestureLeft / 0.3);
      wi *= 1 - fade; ww *= 1 - fade; wr *= 1 - fade;
      if (this.gestureLeft <= 0) this.gesture?.fadeOut(0.2);
    }
    this.idle.setEffectiveWeight(wi);
    this.walk.setEffectiveWeight(ww);
    this.run.setEffectiveWeight(wr);
    this.walk.timeScale = Math.max(0.6, speed / wn);
    this.run.timeScale = Math.max(0.6, speed / rn);
    // Keep the walk and run cycles in step while both are visible.
    if (ww > 0 && wr > 0) this.run.time = (this.walk.time / this.walk.getClip().duration) * this.run.getClip().duration;
    this.mixer.update(dt);
  }

  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.mixer.getRoot()); }
}

// ---------------------------------------------------------------- the player on foot
export class Walker {
  readonly body: Body;
  x = 0; z = 0; heading = 0;
  readonly velocity = new VectorSpring(60, 50, 0.8);   // Sketchbook defaults
  readonly turn = new RelativeSpring(60, 10, 0.5);
  state: 'idle' | 'walk' | 'run' | 'wave' | 'down' | 'wade' | 'swim' = 'idle';
  private knocked = 0; private kvx = 0; private kvz = 0;
  /** Water depth under the walker (-1 on land), set by the game each frame. */
  depth = -1;

  constructor(asset: HumanAsset) { this.body = new Body(asset); }
  get object() { return this.body.root; }
  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  place(x: number, z: number, heading: number) {
    this.x = x; this.z = z; this.heading = heading;
    this.velocity.reset(0, 0); this.turn.target = 0;
  }

  wave() { if (this.speed < 0.6 && this.knocked <= 0) this.body.gestureOnce(); }

  get down() { return this.knocked > 0; }

  /** Bumped by a car: stumble back and get up again (cartoon, no ragdoll). */
  knockdown(dirX: number, dirZ: number, strength: number) {
    if (this.knocked > 0) return;
    const l = Math.hypot(dirX, dirZ) || 1;
    this.knocked = 1.5; this.kvx = dirX / l * Math.min(7, 2 + strength * 0.4); this.kvz = dirZ / l * Math.min(7, 2 + strength * 0.4);
    this.velocity.reset(0, 0);
    this.body.stumble();
  }

  /**
   * dirX/dirZ: wanted direction in world space (length 0..1), already relative
   * to the camera. Returns the movement for collision handling by the caller.
   */
  update(dt: number, dirX: number, dirZ: number, running: boolean) {
    if (this.knocked > 0) {
      this.knocked -= dt;
      const k = Math.exp(-3 * dt); this.kvx *= k; this.kvz *= k;
      this.state = 'down';
      this.body.blend(0, dt, this.depth);
      return { dx: this.kvx * dt, dz: this.kvz * dt };
    }
    const swimming = this.depth > 1.6, wading = this.depth >= 0 && !swimming;
    this.body.swimming = swimming;
    const amount = Math.min(1, Math.hypot(dirX, dirZ));
    const speed = amount * (swimming ? 1.3 : wading ? WALK_SPEED * 0.6 : running ? RUN_SPEED : WALK_SPEED);
    const l = Math.hypot(dirX, dirZ) || 1;
    this.velocity.tx = (dirX / l) * speed; this.velocity.tz = (dirZ / l) * speed;
    if (this.body.gesturing) { this.velocity.tx = 0; this.velocity.tz = 0; }
    this.velocity.simulate(dt);
    // Turn toward the direction of travel (or of the stick while starting off).
    if (amount > 0.05) {
      const want = Math.atan2(dirX, -dirZ);
      this.turn.target = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
    } else this.turn.target = 0;
    this.turn.simulate(dt);
    this.heading += this.turn.position;
    const s = this.speed;
    this.state = swimming ? 'swim' : this.body.gesturing ? 'wave' : wading && s > 0.12 ? 'wade' : s < 0.12 ? 'idle' : s < WALK_SPEED * 1.2 ? 'walk' : 'run';
    this.body.blend(s, dt, this.depth);
    return { dx: this.velocity.x * dt, dz: this.velocity.z * dt };
  }

  sync() {
    this.body.root.position.set(this.x, 0, this.z);
    this.body.root.rotation.y = -this.heading;
  }
}

// ---------------------------------------------------------------- pedestrians
interface Tint { suit: number; tie: number; hair: number; skin: number }
const TINTS: Tint[] = [
  { suit: 0x3f6f8f, tie: 0xf5bd52, hair: 0x2a1d14, skin: 0xc98f6a },
  { suit: 0x8a5a44, tie: 0x2d2f34, hair: 0x14110f, skin: 0x8d5b3f },
  { suit: 0x5c7a52, tie: 0xe8dcc1, hair: 0x6b4a2c, skin: 0xe0b08c },
  { suit: 0x7a6a8f, tie: 0xf495ae, hair: 0x101010, skin: 0xa8714e },
  { suit: 0xb9b2a3, tie: 0x75c4ee, hair: 0x3b2a1e, skin: 0xd9a27b },
  { suit: 0x9b3f3f, tie: 0x1c1d20, hair: 0x241a12, skin: 0x7a4a33 },
];
function applyTint(model: THREE.Object3D, tint: Tint) {
  const swaps: Record<string, number> = { Suit: tint.suit, Tie: tint.tie, Hair: tint.hair, Eyebrows: tint.hair, Skin: tint.skin };
  model.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const recolor = (m: THREE.Material) => {
      const color = swaps[m.name];
      if (color === undefined) return m;
      const c = m.clone() as THREE.MeshStandardMaterial; c.color.setHex(color); return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(recolor) : recolor(mesh.material);
  });
}

interface Ped {
  body: Body; edge: number; from: number; t: number; side: number; speed: number;
  x: number; z: number; h: number; shown: number;
  /** Standing near a place: where, and time until the next gesture. */
  gather?: { x: number; z: number; next: number };
  /** Running off (a driver who just lost their car, or someone dodging a car). */
  flee?: { t: number; dx: number; dz: number; delay: number };
  visible: boolean; frame: number; greetUntil?: number;
}

export interface CrowdSpot { x: number; z: number; kind: string }

export class Crowd {
  readonly group = new THREE.Group();
  private peds: Ped[] = [];
  private frame = 0;

  constructor(asset: HumanAsset, private graph: RoadGraph, count: number, private cull: number) {
    this.graph = graph;
    for (let i = 0; i < count; i++) {
      const body = new Body(asset, TINTS[i % TINTS.length]);
      body.walk.time = Math.random() * body.walk.getClip().duration;
      body.idle.time = Math.random() * body.idle.getClip().duration;
      this.group.add(body.root);
      this.peds.push({ body, edge: 0, from: 0, t: 0, side: 1, speed: 1.3, x: 1e6, z: 1e6, h: 0, shown: 0, visible: false, frame: i });
    }
  }

  /** The road network changed (streaming): put everyone back on the new sidewalks. */
  setGraph(graph: RoadGraph, px: number, pz: number, spots: CrowdSpot[]) {
    this.graph = graph;
    if (graph.edges.length) this.populate(px, pz, spots, true);
  }

  /** A driver gets out at (x, z) and runs away from (fromX, fromZ): stumble, then jog off. */
  flee(x: number, z: number, fromX: number, fromZ: number) {
    const p = this.peds.reduce((a, b) => (Math.hypot(b.x - x, b.z - z) > Math.hypot(a.x - x, a.z - z) ? b : a));
    const dx = x - fromX, dz = z - fromZ, l = Math.hypot(dx, dz) || 1;
    p.gather = undefined;
    p.flee = { t: 7, dx: dx / l, dz: dz / l, delay: 0.7 };
    p.x = x; p.z = z; p.h = p.shown = Math.atan2(dx, -dz);
    p.body.stumble();
  }

  /** A nearby pedestrian acknowledges a wave before continuing along the sidewalk. */
  greet(x:number,z:number) {
    const person=this.peds.filter(p=>p.visible && !p.flee && !p.greetUntil)
      .sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z))[0];
    if(!person || Math.hypot(person.x-x,person.z-z)>12)return;
    person.h=Math.atan2(x-person.x,-(z-person.z));
    person.greetUntil=2.4;
    person.body.gestureOnce(person.body.wave);
  }

  /** People near a fast car hop out of the way (stumble and dodge, no injuries). */
  dodge(x: number, z: number, speed: number) {
    if (speed < 3) return;
    for (const p of this.peds) {
      if (!p.visible || p.flee) continue;
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
      if (d > 2.6) continue;
      p.gather = undefined;
      p.flee = { t: 2.5, dx: dx / (d || 1), dz: dz / (d || 1), delay: 0.6 };
      p.body.stumble();
    }
  }

  /** Put people on sidewalks around (px, pz), and a few around places that matter. */
  populate(px: number, pz: number, spots: CrowdSpot[], all = false) {
    const venues = spots.filter(s => ['audio', 'event', 'room', 'community', 'activity'].includes(s.kind) && Math.hypot(s.x - px, s.z - pz) < this.cull * 1.5);
    const local = this.graph.edges.map((e,i)=>({e,i})).filter(({e})=>{
      const [x,z]=this.graph.nodes[e.a];
      return e.cls!=='motorway' && e.cls!=='trunk' && Math.hypot(x-px,z-pz)<this.cull*.9;
    });
    let v = 0;
    this.peds.forEach((p, i) => {
      if (p.flee || (!all && Math.hypot(p.x - px, p.z - pz) < this.cull * 1.6)) return;
      if (!this.graph.edges.length) return;
      // Roughly a third gather near venues, the rest walk the sidewalks.
      if (venues.length && i % 3 === 0) {
        const s = venues[v++ % venues.length], a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 4;
        p.gather = { x: s.x, z: s.z, next: 2 + Math.random() * 6 };
        p.x = s.x + Math.cos(a) * r; p.z = s.z + Math.sin(a) * r; p.h = Math.atan2(s.x - p.x, -(s.z - p.z)); p.shown = p.h;
        return;
      }
      p.gather = undefined;
      for (let tries = 0; tries < 30; tries++) {
        if (!local.length) break;
        const {i:ei,e} = local[Math.floor(Math.random()*local.length)];
        const [ax, az] = this.graph.nodes[e.a];
        const d = Math.hypot(ax - px, az - pz);
        if (d > this.cull * (all ? 0.9 : 1.3) || (!all && d < 40) || e.cls === 'motorway' || e.cls === 'trunk') continue;
        Object.assign(p, { edge: ei, from: Math.random() < 0.5 ? e.a : e.b, t: Math.random() * e.len, side: Math.random() < 0.5 ? -1 : 1, speed: 1.15 + Math.random() * 0.45 });
        this.pose(p); p.shown = p.h;
        break;
      }
    });
  }

  private pose(p: Ped) {
    const e = this.graph.edges[p.edge], to = this.graph.other(e, p.from);
    const [ax, az] = this.graph.nodes[p.from], [bx, bz] = this.graph.nodes[to];
    const ux = (bx - ax) / e.len, uz = (bz - az) / e.len;
    const off = (e.width / 2 + 1.3) * p.side;           // on the sidewalk
    p.x = ax + ux * p.t - uz * off; p.z = az + uz * p.t + ux * off;
    p.h = Math.atan2(ux, -uz);
  }

  update(dt: number, camX: number, camZ: number) {
    this.frame++;
    for (const p of this.peds) {
      const d = Math.hypot(p.x - camX, p.z - camZ);
      p.visible = d < this.cull;
      let walkSpeed=p.speed;
      p.body.root.visible = p.visible;
      if (p.flee) {
        const f = p.flee;
        f.t -= dt; f.delay -= dt;
        if (f.delay <= 0) { p.x += f.dx * 5 * dt; p.z += f.dz * 5 * dt; p.h = Math.atan2(f.dx, -f.dz); }
        if (f.t <= 0) { p.flee = undefined; p.x = p.z = 1e6; }
      } else if (p.greetUntil) {
        p.greetUntil=p.greetUntil>dt?p.greetUntil-dt:undefined;
      } else if (p.gather) {
        p.gather.next -= dt;
        if (p.gather.next <= 0 && p.visible) { p.body.gestureOnce(Math.random() < 0.5 ? p.body.wave : p.body.interact); p.gather.next = 5 + Math.random() * 8; }
      } else {
        if(p.visible){
          const fx=Math.sin(p.h),fz=-Math.cos(p.h);
          // Leave a step between walkers heading the same way on a narrow sidewalk.
          if(this.peds.some(other=>{
            if(other===p || !other.visible || other.flee || Math.cos(p.h-other.h)<0.7)return false;
            const dx=other.x-p.x,dz=other.z-p.z,forward=dx*fx+dz*fz;
            return forward>0 && forward<1.4 && Math.abs(dx*fz-dz*fx)<0.7;
          }))walkSpeed*=0.4;
        }
        p.t += walkSpeed * dt;
        let e = this.graph.edges[p.edge], guard = 0;
        if (!e || !this.graph.nodes[p.from] || (p.from!==e.a && p.from!==e.b)) { p.x=p.z=1e6;continue; }
        while (p.t > e.len && guard++ < 6) {
          p.t -= e.len;
          const node = this.graph.other(e, p.from);
          const next = this.graph.adj[node].filter(i => i !== p.edge && !['motorway','trunk'].includes(this.graph.edges[i].cls));
          p.edge = next.length ? next[Math.floor(Math.random() * next.length)] : p.edge;
          p.from = node;
          e = this.graph.edges[p.edge];
        }
        this.pose(p);
      }
      if (!p.visible) continue;
      p.shown += Math.atan2(Math.sin(p.h - p.shown), Math.cos(p.h - p.shown)) * Math.min(1, dt * 6);
      p.body.root.position.set(p.x, 0, p.z);
      p.body.root.rotation.y = -p.shown;
      // Animation level of detail: far people update every other frame.
      const every = d < 50 ? 1 : 2;
      if ((this.frame + p.frame) % every === 0) p.body.blend(p.flee ? (p.flee.delay > 0 ? 0 : 5) : p.gather || p.greetUntil ? 0 : walkSpeed, dt * every);
    }
  }

  snapshot() {
    return this.peds.map((p,id)=>({id,x:p.x,z:p.z,visible:p.visible,greeting:!!p.greetUntil,gathering:!!p.gather}));
  }

  get visibleCount() { return this.peds.filter(p => p.visible).length; }

  dispose() { this.peds.forEach(p => p.body.dispose()); }
}
