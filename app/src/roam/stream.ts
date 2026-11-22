// Streaming world for Free Roam: only the part around you is loaded and built.
//
// Data: the hidden street map is moved ahead of the player so MapLibre loads the
// vector tiles there (OpenFreeMap); tile layers are then read one per frame
// into ~192 m chunks (data.ts). Meshes: chunks inside the view radius are built
// a few milliseconds per frame, nearest and in front first, and disposed once
// they fall behind a larger radius. Far chunk data is dropped so memory stays
// flat on long drives. Approach after three.js "infinite terrain" chunk demos and
// the chunked streaming used by browser open worlds; no code copied.

import * as THREE from 'three';
import type maplibregl from 'maplibre-gl';
import { streetscape } from './streetscape';
import { buildAreas, buildBuildings, buildRoads } from './build';
import { CHUNK, chunkOf, finishBuildings, readLayer, type Area, type Frame, type Landmark, type NamedLine, type RawBuilding, type Road, type Sink, type XZ } from './data';
import { RoadGraph } from './graph';
import type { Quality } from './quality';

const LAYERS = ['transportation', 'building', 'water', 'transportation_name', 'park', 'landcover', 'poi'];
const CELL = 16;

interface Chunk {
  key: string; cx: number; cz: number;
  roads: Road[]; raw: RawBuilding[]; names: NamedLine[]; keys: string[];
  dirty?: boolean;
  built?: {
    group: THREE.Group; segments: Float32Array; grid: Map<number, number[]>; stamp: Int32Array;
    minimap: HTMLCanvasElement; areas: Set<string>;
  };
}
interface AreaEntry { area: Area; mesh?: THREE.Group; users: Set<string> }

export interface StreamStats { chunks: number; built: number; lastBuildMs: number; maxBuildMs: number; loading: boolean }

export class WorldStream implements Sink {
  readonly chunks = new Map<string, Chunk>();
  private areas = new Map<string, AreaEntry>();
  readonly landmarks: Landmark[] = [];
  private seen = new Set<string>();
  graph = new RoadGraph([]);
  graphVersion = 0;
  private graphAt: XZ = [1e9, 1e9];
  private graphDirty = false;
  private queue: string[] = [];            // layers still to read from the current tiles
  private loading = false;
  private dataRect: [number, number, number, number] | null = null;
  private stampId = 0;
  readonly stats: StreamStats = { chunks: 0, built: 0, lastBuildMs: 0, maxBuildMs: 0, loading: false };
  readonly mapScale = 0.75;                // px per metre in chunk minimap tiles

  constructor(private map: maplibregl.Map, private frame: Frame, private scene: THREE.Scene, private q: Quality) {}

  // ---------------------------------------------------------------- Sink (data.ts writes here)
  claim(key: string, chunk: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (chunk) this.chunk(chunk).keys.push(key);
    return true;
  }
  road(chunk: string, road: Road) { const c=this.chunk(chunk); c.roads.push(road); c.dirty=true; if (road.drivable) this.graphDirty = true; }
  name(chunk: string, line: NamedLine) { this.chunk(chunk).names.push(line); }
  building(chunk: string, b: RawBuilding) { const c=this.chunk(chunk); c.raw.push(b); c.dirty=true; }
  area(area: Area) { this.areas.set(area.key, { area, users: new Set() }); }
  landmark(l: Landmark) { this.landmarks.push(l); }

  private chunk(key: string) {
    let c = this.chunks.get(key);
    if (!c) {
      const [cx, cz] = key.split(',').map(Number);
      c = { key, cx, cz, roads: [], raw: [], names: [], keys: [] };
      this.chunks.set(key, c);
    }
    return c;
  }

  // ---------------------------------------------------------------- data loading
  /** Read the tiles the map currently has (all layers at once, used for the first area). */
  readAll() { for (const layer of LAYERS) readLayer(this.map, this.frame, layer, this); this.dataRect = this.mapRect(); this.graphDirty = true; }

  private mapRect(): [number, number, number, number] {
    const b = this.map.getBounds();
    const [x0, z0] = this.frame.toLocal(b.getWest(), b.getNorth()), [x1, z1] = this.frame.toLocal(b.getEast(), b.getSouth());
    return [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];
  }

  /** Move the hidden map ahead of the player when they near the edge of what is loaded. */
  private ensureData(px: number, pz: number, fx: number, fz: number) {
    if (this.loading || this.queue.length) return;
    const r = this.dataRect, margin = this.q.viewRadius + 250;
    if (r && px - r[0] > margin && r[2] - px > margin && pz - r[1] > margin && r[3] - pz > margin) return;
    this.loading = true;
    const ahead = this.q.viewRadius;
    const [lng, lat] = this.frame.toLngLat(px + fx * ahead, pz + fz * ahead);
    this.map.jumpTo({ center: [lng, lat], zoom: 14.2 });
    let settled=false;
    const done = () => { if(settled)return;settled=true;this.loading = false; this.dataRect = this.mapRect(); this.queue = [...LAYERS]; };
    const timer = setTimeout(done, 9000);
    this.map.once('idle', () => { clearTimeout(timer); done(); });
  }

  // ---------------------------------------------------------------- per frame
  update(px: number, pz: number, fx: number, fz: number) {
    this.ensureData(px, pz, fx, fz);
    // One tile layer per frame keeps reads from stalling a single frame too long.
    if (this.queue.length) { readLayer(this.map, this.frame, this.queue.shift()!, this); }
    if (this.graphDirty || Math.hypot(px - this.graphAt[0], pz - this.graphAt[1]) > 500) this.rebuildGraph(px, pz);
    this.buildSome(px, pz, fx, fz);
    this.disposeFar(px, pz);
    this.stats.chunks = this.chunks.size;
    this.stats.loading = this.loading || this.queue.length > 0;
  }

  private rebuildGraph(px: number, pz: number) {
    const roads: Road[] = [];
    const r = this.q.viewRadius + 500;
    for (const c of this.chunks.values()) {
      if (Math.hypot((c.cx + 0.5) * CHUNK - px, (c.cz + 0.5) * CHUNK - pz) < r) roads.push(...c.roads);
    }
    this.graph = new RoadGraph(roads);
    this.graphVersion++; this.graphAt = [px, pz]; this.graphDirty = false;
  }

  private buildSome(px: number, pz: number, fx: number, fz: number) {
    const view = this.q.viewRadius, budget = this.q.buildBudgetMs;
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK), span = Math.ceil(view / CHUNK);
    const todo: { c: Chunk; p: number }[] = [];
    for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) {
      const c = this.chunks.get((pcx + dx) + ',' + (pcz + dz));
      if (!c || (c.built && !c.dirty)) continue;
      const ox = (c.cx + 0.5) * CHUNK - px, oz = (c.cz + 0.5) * CHUNK - pz, d = Math.hypot(ox, oz);
      if (d > view + CHUNK * 0.7) continue;
      // Nearest first, and what is in front of you before what is behind.
      todo.push({ c, p: d - ((ox * fx + oz * fz) / (d || 1)) * CHUNK * 0.8 });
    }
    todo.sort((a, b) => a.p - b.p);
    const start = performance.now();
    for (const { c } of todo) {
      const t = performance.now();
      this.build(c);
      const ms = performance.now() - t;
      this.stats.lastBuildMs = ms; this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, ms);
      if (performance.now() - start > budget) break;
    }
  }

  /** Build the chunk the player stands in and its neighbours right away (first playable frame). */
  buildAround(px: number, pz: number) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const c = this.chunks.get((pcx + dx) + ',' + (pcz + dz)); if (c && !c.built) this.build(c); }
  }

  private build(c: Chunk) {
    if(c.built)this.unbuild(c);
    c.dirty=false;
    const group = new THREE.Group();
    group.name = 'chunk ' + c.key;
    group.add(buildRoads(c.roads));
    const buildings = finishBuildings(c.raw, this.q.chunkBuildings);
    const { mesh, segments } = buildBuildings(buildings, this.q.windows);
    group.add(mesh);
    const grid = new Map<number, number[]>();
    for (let i = 0; i < segments.length; i += 4) {
      const ax = segments[i], az = segments[i + 1], bx = segments[i + 2], bz = segments[i + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
      let last = -1;
      for (let s = 0; s <= steps; s++) {
        const k = cellKey(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps);
        if (k === last) continue; last = k;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
    }
    // Areas (parks, water) are shared between chunks and built once.
    const x0 = c.cx * CHUNK, z0 = c.cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
    const areas = new Set<string>();
    for (const [key, e] of this.areas) {
      const b = e.area.box;
      if (b[0] > x1 || b[2] < x0 || b[1] > z1 || b[3] < z0) continue;
      areas.add(key); e.users.add(c.key);
      if (!e.mesh) { e.mesh = buildAreas([e.area]); this.scene.add(e.mesh); }
    }
    group.add(streetscape(c.roads,buildings,[...areas].map(k=>this.areas.get(k)!.area),x0,z0,CHUNK));
    this.scene.add(group);
    c.built = { group, segments, grid, stamp: new Int32Array(segments.length / 4), minimap: this.minimapTile(c, areas), areas };
    this.stats.built++;
  }

  private minimapTile(c: Chunk, areas: Set<string>) {
    const s = this.mapScale, size = Math.ceil(CHUNK * s);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#1c1f22'; g.fillRect(0, 0, size, size);
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK;
    for (const key of areas) {
      const a = this.areas.get(key)!.area;
      g.fillStyle = a.kind === 'water' ? '#1f4150' : '#2c4034';
      g.beginPath(); a.outer.forEach((p, i) => (i ? g.lineTo((p[0] - ox) * s, (p[1] - oz) * s) : g.moveTo((p[0] - ox) * s, (p[1] - oz) * s))); g.closePath(); g.fill();
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const r of [...c.roads].sort((a, b) => a.width - b.width)) {
      g.strokeStyle = r.width >= 10 ? '#d9d2bd' : r.width >= 7 ? '#8d908b' : r.drivable ? '#5d615f' : '#3e4542';
      g.lineWidth = Math.max(1, r.width * s * 1.1);
      g.beginPath(); r.pts.forEach((p, i) => (i ? g.lineTo((p[0] - ox) * s, (p[1] - oz) * s) : g.moveTo((p[0] - ox) * s, (p[1] - oz) * s))); g.stroke();
    }
    return canvas;
  }

  private disposeFar(px: number, pz: number) {
    const keep = this.q.viewRadius * 1.35 + CHUNK, forget = Math.max(3500, this.q.viewRadius * 4);
    for (const c of this.chunks.values()) {
      const d = Math.hypot((c.cx + 0.5) * CHUNK - px, (c.cz + 0.5) * CHUNK - pz);
      if (c.built && d > keep) this.unbuild(c);
      if (d > forget) { for (const k of c.keys) this.seen.delete(k); this.chunks.delete(c.key); }
    }
    for (const [key, e] of this.areas) {
      const b = e.area.box;
      const d = Math.hypot(Math.max(b[0] - px, 0, px - b[2]), Math.max(b[1] - pz, 0, pz - b[3]));
      if (d > forget) { this.seen.delete('a' + key); this.disposeArea(e); this.areas.delete(key); }
    }
    if (this.landmarks.length > 300) this.landmarks.splice(0, this.landmarks.length - 300);
  }

  private unbuild(c: Chunk) {
    const b = c.built!;
    this.scene.remove(b.group);
    b.group.traverse(o => { const m = o as THREE.Mesh; if(m instanceof THREE.InstancedMesh)m.dispose(); m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; mat?.dispose?.(); });
    for (const key of b.areas) { const e = this.areas.get(key); if (!e) continue; e.users.delete(c.key); if (!e.users.size) this.disposeArea(e); }
    c.built = undefined;
    this.stats.built--;
  }

  private disposeArea(e: AreaEntry) {
    if (!e.mesh) return;
    this.scene.remove(e.mesh);
    e.mesh.traverse(o => { const m = o as THREE.Mesh; if(m instanceof THREE.InstancedMesh)m.dispose(); m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
    e.mesh = undefined;
  }

  dispose() { for (const c of this.chunks.values()) if (c.built) this.unbuild(c); for (const e of this.areas.values()) this.disposeArea(e); }

  // ---------------------------------------------------------------- queries
  /** Is the ground under (x, z) built yet? */
  ready(x: number, z: number) { return Boolean(this.chunks.get(chunkOf(x, z))?.built); }

  /** Separate a circle from building walls. Returns the push and wall normal, or null. Allocation-free. */
  pushOut(x: number, z: number, r: number, out: { dx: number; dz: number; nx: number; nz: number }) {
    let dx = 0, dz = 0, hits = 0;
    const stamp = ++this.stampId;
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const qx = x + ox * CELL, qz = z + oz * CELL;
      const c = this.chunks.get(chunkOf(qx, qz))?.built;
      if (!c) continue;
      const cell = c.grid.get(cellKey(qx, qz));
      if (!cell) continue;
      const s = c.segments;
      for (let n = 0; n < cell.length; n++) {
        const i = cell[n];
        if (c.stamp[i >> 2] === stamp) continue; c.stamp[i >> 2] = stamp;
        const ax = s[i], az = s[i + 1], vx = s[i + 2] - ax, vz = s[i + 3] - az;
        const l2 = vx * vx + vz * vz || 1;
        let t = ((x + dx - ax) * vx + (z + dz - az) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x + dx - (ax + vx * t), ez = z + dz - (az + vz * t), d = Math.hypot(ex, ez);
        if (d >= r || d < 1e-6) continue;
        dx += ex / d * (r - d); dz += ez / d * (r - d); hits++;
      }
    }
    if (!hits) return null;
    const l = Math.hypot(dx, dz) || 1;
    out.dx = dx; out.dz = dz; out.nx = dx / l; out.nz = dz / l;
    return out;
  }

  /** Depth into water at (x, z): distance from the shore if inside a water area, else -1. */
  waterDepth(x: number, z: number) {
    for (const e of this.areas.values()) {
      const a = e.area, b = a.box;
      if (a.kind !== 'water' || x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      if (!inside(a.outer, x, z) || a.holes.some(h => inside(h, x, z))) continue;
      const hit=this.graph.nearest(x,z,12);
      if(hit && this.graph.edges[hit.edge].bridge && hit.dist<=this.graph.edges[hit.edge].width/2) return -1;
      let d = Infinity;
      for (const ring of [a.outer, ...a.holes]) d = Math.min(d, edgeDistance(ring, x, z));
      return d;
    }
    return -1;
  }

  streetName(x: number, z: number) {
    let name = '', best = 24;
    const pcx = Math.floor(x / CHUNK), pcz = Math.floor(z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const n of this.chunks.get((pcx + dx) + ',' + (pcz + dz))?.names ?? []) {
        for (let i = 1; i < n.pts.length; i++) {
          const [ax, az] = n.pts[i - 1], vx = n.pts[i][0] - ax, vz = n.pts[i][1] - az, l2 = vx * vx + vz * vz || 1;
          let t = ((x - ax) * vx + (z - az) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
          if (d < best) { best = d; name = n.name; }
        }
      }
    }
    return name;
  }

  /** Built chunk minimap tiles near a point, for drawing. */
  *tiles(x: number, z: number, radius: number) {
    for (const c of this.chunks.values()) {
      if (!c.built) continue;
      if (Math.abs((c.cx + 0.5) * CHUNK - x) > radius + CHUNK || Math.abs((c.cz + 0.5) * CHUNK - z) > radius + CHUNK) continue;
      yield { x: c.cx * CHUNK, z: c.cz * CHUNK, canvas: c.built.minimap };
    }
  }

  /** Major-road points in built chunks, for props and parked cars. */
  roadsNear(x: number, z: number, radius: number) {
    const out: Road[] = [];
    for (const c of this.chunks.values()) if (c.built && Math.hypot((c.cx + 0.5) * CHUNK - x, (c.cz + 0.5) * CHUNK - z) < radius) out.push(...c.roads);
    return out;
  }
}

const cellKey = (x: number, z: number) => (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768);

function inside(ring: XZ[], x: number, z: number) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
function edgeDistance(ring: XZ[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], vx = ring[i][0] - ax, vz = ring[i][1] - az, l2 = vx * vx + vz * vz || 1;
    let t = ((x - ax) * vx + (z - az) * vz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return best;
}
