// World data for Free Roam, read from the street map's own vector tiles
// (OpenMapTiles schema via OpenFreeMap). No extra downloads: whatever tiles the
// (hidden) map has loaded become drivable world, anywhere on Earth.
//
// Coordinates are local metres around an origin: x = east, z = south (so -z is north).
// Data is read one tile layer at a time and binned into square chunks, so the
// world can stream as you move (see stream.ts).

import type maplibregl from 'maplibre-gl';
import type { Position } from 'geojson';

export type XZ = [number, number];
export const CHUNK = 192;

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
export interface RawBuilding { ring: XZ[]; tagged: number }
export interface Building { ring: XZ[]; height: number; color: number; seed: number }
export interface Area { key: string; kind: 'water' | 'park'; outer: XZ[]; holes: XZ[][]; box: [number, number, number, number] }
export interface NamedLine { name: string; pts: XZ[] }
export interface Landmark { name: string; x: number; z: number; kind: string }

export const chunkOf = (x: number, z: number) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);

const WIDTH: Record<string, number> = {
  motorway: 15, trunk: 13, primary: 12, secondary: 10.5, tertiary: 10, minor: 8, service: 5.8,
  track: 3.2, path: 2.2, raceway: 10, busway: 7,
};
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'raceway', 'busway']);
const SHELLS = [0x4b4f55, 0x55585c, 0x5e5a55, 0x4d5560, 0x625c57, 0x575d5a, 0x6a6157];

export const hash = (a: number, b: number) => {
  let n = Math.imul(Math.round(a * 10) | 0, 73856093) ^ Math.imul(Math.round(b * 10) | 0, 19349663);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
function ringArea(ring: XZ[]) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}
export const centroid = (ring: XZ[]): XZ => {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
};
const toRing = (frame: Frame, coords: Position[]): XZ[] => {
  const ring = coords.map(c => frame.toLocal(c[0], c[1]));
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  return ring;
};
const lines = (g: GeoJSON.Geometry) => g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
const polys = (g: GeoJSON.Geometry) => g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];

/** Where features land. Implemented by the stream. */
export interface Sink {
  /** Returns false if this key was already read (features repeat across tiles and reloads). */
  claim(key: string, chunk: string): boolean;
  road(chunk: string, road: Road): void;
  name(chunk: string, line: NamedLine): void;
  building(chunk: string, b: RawBuilding): void;
  area(area: Area): void;
  landmark(l: Landmark): void;
}

/** Read one source layer of the loaded tiles into the sink. Layers are read on separate frames. */
export function readLayer(map: maplibregl.Map, frame: Frame, layer: string, sink: Sink) {
  const features = map.querySourceFeatures('omt', { sourceLayer: layer });
  if (layer === 'transportation') {
    for (const f of features) {
      const cls = String(f.properties.class ?? '');
      if (!(cls in WIDTH) || f.properties.brunnel === 'tunnel') continue;
      for (const line of lines(f.geometry)) {
        const pts = line.map(c => frame.toLocal(c[0], c[1]));
        if (pts.length < 2) continue;
        const key = 'r' + cls + pts[0].map(v => v.toFixed(1)).join() + pts[pts.length - 1].map(v => v.toFixed(1)).join() + pts.length;
        // Split the line into per-chunk pieces by segment midpoints.
        let piece: XZ[] = [pts[0]], current = '';
        const flush = () => {
          if (piece.length > 1 && current && sink.claim(key + '@' + current + piece.length, current)) {
            sink.road(current, { cls, width: WIDTH[cls], drivable: DRIVABLE.has(cls), pts: piece, bridge: f.properties.brunnel === 'bridge' });
          }
        };
        for (let i = 1; i < pts.length; i++) {
          const c = chunkOf((pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2);
          if (current && c !== current) { flush(); piece = [pts[i - 1]]; }
          current = c; piece.push(pts[i]);
        }
        flush();
      }
    }
  } else if (layer === 'transportation_name') {
    for (const f of features) {
      const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
      if (!name) continue;
      for (const line of lines(f.geometry)) {
        const pts = line.map(c => frame.toLocal(c[0], c[1]));
        const chunk = chunkOf(pts[0][0], pts[0][1]);
        if (sink.claim('n' + name + pts[0].map(v => v.toFixed(0)).join(), chunk)) sink.name(chunk, { name, pts });
      }
    }
  } else if (layer === 'building') {
    for (const f of features) {
      if (f.properties.hide_3d) continue;
      for (const poly of polys(f.geometry)) {
        const ring = toRing(frame, poly[0]);
        if (ring.length < 3) continue;
        const c = centroid(ring), chunk = chunkOf(c[0], c[1]);
        if (!sink.claim('b' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + ',' + ring.length, chunk)) continue;
        if (ringArea(ring) > 0) ring.reverse();
        sink.building(chunk, { ring, tagged: Number(f.properties.render_height) || 0 });
      }
    }
  } else if (layer === 'water' || layer === 'park' || layer === 'landcover') {
    const kind = layer === 'water' ? 'water' : 'park';
    for (const f of features) {
      if (layer === 'landcover' && !['grass', 'wood', 'farmland'].includes(String(f.properties.class))) continue;
      for (const poly of polys(f.geometry)) {
        const outer = toRing(frame, poly[0]);
        if (outer.length < 3) continue;
        const key = kind + outer[0].map(v => v.toFixed(0)).join() + outer.length;
        if (!sink.claim('a' + key, '')) continue;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const [x, z] of outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
        sink.area({ key, kind, outer, holes: poly.slice(1).map(h => toRing(frame, h)).filter(h => h.length >= 3), box: [minX, minZ, maxX, maxZ] });
      }
    }
    if (layer === 'park') {
      for (const f of features) {
        const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
        if (!name || f.geometry.type !== 'Polygon') continue;
        const c = centroid(toRing(frame, f.geometry.coordinates[0]));
        if (sink.claim('lp' + name, '')) sink.landmark({ name, x: c[0], z: c[1], kind: 'park' });
      }
    }
  } else if (layer === 'poi') {
    for (const f of features) {
      const name = String(f.properties['name:en'] ?? f.properties.name ?? '').trim();
      if (!name || f.geometry.type !== 'Point' || Number(f.properties.rank ?? 99) > 12) continue;
      const [x, z] = frame.toLocal(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      if (sink.claim('lo' + name, '')) sink.landmark({ name, x, z, kind: String(f.properties.class ?? 'place') });
    }
  }
}

/**
 * Building heights: OSM height or levels when the data has them (render_height
 * above the OpenMapTiles default); otherwise a stable, varied guess from the
 * footprint size and a hash, with occasional towers where buildings are dense.
 */
export function finishBuildings(raw: RawBuilding[], max: number): Building[] {
  const cells = new Map<string, number>();
  const cellOf = (p: XZ) => Math.floor(p[0] / 100) + ',' + Math.floor(p[1] / 100);
  for (const b of raw) { const k = cellOf(centroid(b.ring)); cells.set(k, (cells.get(k) ?? 0) + 1); }
  const busiest = Math.max(1, ...cells.values());
  return raw.slice(0, max).map(({ ring, tagged }) => {
    const c = centroid(ring);
    const density = (cells.get(cellOf(c)) ?? 0) / busiest;
    const area = Math.abs(ringArea(ring)), h = hash(c[0], c[1]), seed = hash(c[1], c[0]);
    let height: number;
    if (tagged > 6.5) height = Math.min(tagged, 320);
    else {
      if (area < 60) height = 3.5 + h * 4;
      else if (area < 220) height = 6 + h * 9;
      else if (area < 700) height = 9 + h * 18;
      else if (area < 2500) height = 12 + h * 26;
      else height = 10 + h * 22;
      if (density > 0.55 && area > 250 && area < 4000 && h > 0.9) height = 45 + hash(c[1], c[0]) * 90;
    }
    return { ring, height, color: SHELLS[Math.floor(seed * SHELLS.length)], seed };
  });
}
