// World data for Free Roam, read from the street map's own vector tiles
// (OpenMapTiles schema via OpenFreeMap). No extra downloads: whatever area the
// map has loaded becomes the drivable world, anywhere on Earth.
//
// Coordinates are local metres around an origin: x = east, z = south (so -z is north).

import type maplibregl from 'maplibre-gl';
import type { Position } from 'geojson';

export type XZ = [number, number];

export class Frame {
  readonly mx: number;
  readonly mz = 110574;
  constructor(readonly lng0: number, readonly lat0: number) {
    this.mx = 111320 * Math.cos(lat0 * Math.PI / 180);
  }
  toLocal(lng: number, lat: number): XZ { return [(lng - this.lng0) * this.mx, -(lat - this.lat0) * this.mz]; }
  toLngLat(x: number, z: number): [number, number] { return [this.lng0 + x / this.mx, this.lat0 - z / this.mz]; }
}

export interface Road { cls: string; width: number; drivable: boolean; pts: XZ[]; bridge: boolean }
export interface Building { ring: XZ[]; height: number; color: number; seed: number }
export interface Area { kind: 'water' | 'park'; outer: XZ[]; holes: XZ[][] }
export interface NamedLine { name: string; pts: XZ[] }
export interface Landmark { name: string; x: number; z: number; kind: string }

export interface WorldData {
  roads: Road[]; buildings: Building[]; areas: Area[]; names: NamedLine[]; landmarks: Landmark[];
}

const WIDTH: Record<string, number> = {
  motorway: 15, trunk: 13, primary: 12, secondary: 10.5, tertiary: 9, minor: 7, service: 4.8,
  track: 3.2, path: 2.2, raceway: 10, busway: 7,
};
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'raceway', 'busway']);
const SHELLS = [0x4b4f55, 0x55585c, 0x5e5a55, 0x4d5560, 0x625c57, 0x575d5a, 0x6a6157];

const hash = (a: number, b: number) => {
  let n = Math.imul(Math.round(a * 10) | 0, 73856093) ^ Math.imul(Math.round(b * 10) | 0, 19349663);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

function ringArea(ring: XZ[]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}
const centroid = (ring: XZ[]): XZ => {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
};

/**
 * Building height: OSM height or levels when the data has them (render_height
 * above the OpenMapTiles default); otherwise a stable, varied guess from the
 * footprint size and a hash, with occasional towers where buildings are dense.
 */
function heightFor(props: Record<string, unknown>, ring: XZ[], density: number) {
  const tagged = Number(props.render_height);
  const area = Math.abs(ringArea(ring));
  const [cx, cz] = centroid(ring);
  const h = hash(cx, cz);
  if (Number.isFinite(tagged) && tagged > 6.5) return Math.min(tagged, 320);
  let height: number;
  if (area < 60) height = 3.5 + h * 4;
  else if (area < 220) height = 6 + h * 9;
  else if (area < 700) height = 9 + h * 18;
  else if (area < 2500) height = 12 + h * 26;
  else height = 10 + h * 22;                          // big footprints: malls, warehouses
  if (density > 0.55 && area > 250 && area < 4000 && h > 0.9) height = 45 + hash(cz, cx) * 90; // a few towers
  return height;
}

const toRing = (frame: Frame, coords: Position[]): XZ[] => {
  const ring = coords.map(c => frame.toLocal(c[0], c[1]));
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  return ring;
};

export function extractWorld(map: maplibregl.Map, frame: Frame, radius: number): WorldData {
  const inside = (p: XZ) => p[0] * p[0] + p[1] * p[1] < radius * radius;
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));

  // Roads.
  const roads: Road[] = [];
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'transportation' })) {
    const cls = String(f.properties.class ?? '');
    if (!(cls in WIDTH) || f.properties.brunnel === 'tunnel') continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      const pts = line.map(c => frame.toLocal(c[0], c[1]));
      if (pts.length < 2 || !pts.some(inside)) continue;
      const key = cls + pts[0].map(v => v.toFixed(1)).join() + pts[pts.length - 1].map(v => v.toFixed(1)).join() + pts.length;
      if (!once('r' + key)) continue;
      roads.push({ cls, width: WIDTH[cls], drivable: DRIVABLE.has(cls), pts, bridge: f.properties.brunnel === 'bridge' });
    }
  }

  // Street names.
  const names: NamedLine[] = [];
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'transportation_name' })) {
    const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
    if (!name) continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      const pts = line.map(c => frame.toLocal(c[0], c[1]));
      if (pts.some(inside) && once('n' + name + pts[0].map(v => v.toFixed(0)).join())) names.push({ name, pts });
    }
  }

  // Buildings: footprints first, then heights (which need local density).
  const raw: { ring: XZ[]; props: Record<string, unknown> }[] = [];
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'building' })) {
    if (f.properties.hide_3d) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const ring = toRing(frame, poly[0]);
      if (ring.length < 3) continue;
      const c = centroid(ring);
      if (!inside(c)) continue;
      if (!once('b' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + ',' + ring.length)) continue;
      raw.push({ ring, props: f.properties });
    }
  }
  // Density per 100 m cell, used to place a few towers in built-up blocks.
  const cells = new Map<string, number>();
  const cellOf = (p: XZ) => Math.floor(p[0] / 100) + ',' + Math.floor(p[1] / 100);
  for (const b of raw) { const k = cellOf(centroid(b.ring)); cells.set(k, (cells.get(k) ?? 0) + 1); }
  const busiest = Math.max(1, ...cells.values());
  // Keep the nearest buildings within the cap (performance).
  raw.sort((a, b) => { const ca = centroid(a.ring), cb = centroid(b.ring); return ca[0] ** 2 + ca[1] ** 2 - cb[0] ** 2 - cb[1] ** 2; });
  const buildings: Building[] = raw.slice(0, 6000).map(({ ring, props }) => {
    const c = centroid(ring);
    const density = (cells.get(cellOf(c)) ?? 0) / busiest;
    const seed = hash(c[1], c[0]);
    if (ringArea(ring) > 0) ring.reverse(); // consistent winding (clockwise in x/z) for outward walls
    return { ring, height: heightFor(props, ring, density), color: SHELLS[Math.floor(seed * SHELLS.length)], seed };
  });

  // Water and parks.
  const areas: Area[] = [];
  const addAreas = (layer: string, kind: Area['kind'], filter?: (p: Record<string, unknown>) => boolean) => {
    for (const f of map.querySourceFeatures('omt', { sourceLayer: layer })) {
      if (filter && !filter(f.properties)) continue;
      const g = f.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const outer = toRing(frame, poly[0]);
        if (outer.length < 3) continue;
        const key = kind + outer[0].map(v => v.toFixed(0)).join() + outer.length;
        if (!once('a' + key)) continue;
        if (!outer.some(p => Math.abs(p[0]) < radius * 1.4 && Math.abs(p[1]) < radius * 1.4)) continue;
        areas.push({ kind, outer, holes: poly.slice(1).map(h => toRing(frame, h)).filter(h => h.length >= 3) });
      }
    }
  };
  addAreas('water', 'water');
  addAreas('park', 'park');
  addAreas('landcover', 'park', p => ['grass', 'wood', 'farmland'].includes(String(p.class)));

  // Landmarks: named parks and well-known points of interest.
  const landmarks: Landmark[] = [];
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'park' })) {
    const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
    if (!name || f.geometry.type !== 'Polygon') continue;
    const c = centroid(toRing(frame, f.geometry.coordinates[0]));
    if (inside(c) && once('lp' + name)) landmarks.push({ name, x: c[0], z: c[1], kind: 'park' });
  }
  for (const f of map.querySourceFeatures('omt', { sourceLayer: 'poi' })) {
    const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
    const rank = Number(f.properties.rank ?? 99);
    if (!name || f.geometry.type !== 'Point' || rank > 12) continue;
    const [x, z] = frame.toLocal(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    if (inside([x, z]) && once('lo' + name)) landmarks.push({ name, x, z, kind: String(f.properties.class ?? 'place') });
  }
  landmarks.sort((a, b) => a.x ** 2 + a.z ** 2 - (b.x ** 2 + b.z ** 2));

  return { roads, buildings, areas, names, landmarks: landmarks.slice(0, 40) };
}
