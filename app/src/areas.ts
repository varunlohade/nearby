import type { Area, AreaSeed, CityConfig, LatLng } from './types';

const KM_LAT = 1 / 110.6;
const kmLng = (lat: number) => 1 / (111.3 * Math.cos((lat * Math.PI) / 180));

/** Ward-like outline: 10 corners with a fixed jitter. Real build would load ward boundaries. */
export function ringAround(c: LatLng, r: number, s: number, n = 10): LatLng[] {
  const pts: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2 + s;
    const k = r * (0.82 + 0.3 * Math.abs(Math.sin(s * 3.1 + i * 1.7)));
    pts.push({ lat: c.lat + Math.sin(t) * k * KM_LAT, lng: c.lng + Math.cos(t) * k * kmLng(c.lat) });
  }
  pts.push(pts[0]);
  return pts;
}

export const toArea = (a: AreaSeed, i: number, founder?: string): Area =>
  ({ ...a, ring: ringAround(a.center, a.radiusKm, i * 0.9 + 0.4), founder });

export function inRing(p: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

export function distKm(a: LatLng, b: LatLng): number {
  return Math.hypot((a.lat - b.lat) / KM_LAT, (a.lng - b.lng) / kmLng(a.lat));
}

export const areaAt = (p: LatLng, areas: Area[]) => areas.find((a) => inRing(p, a.ring));

/**
 * Runs on the device only. Turns raw coordinates into an area id and forgets the coordinates.
 * Inside an outline wins; otherwise the nearest area within 3 km; otherwise none.
 */
export function snapToArea(p: LatLng, areas: Area[]): Area | undefined {
  const hit = areaAt(p, areas);
  if (hit) return hit;
  let best: Area | undefined, bestD = 3;
  for (const a of areas) { const d = distKm(p, a.center); if (d < bestD) { best = a; bestD = d; } }
  return best;
}

const KEY = (city: CityConfig) => `nearby.areas.${city.id}`;

export function loadAreas(city: CityConfig): Area[] {
  const base = city.areas.map((a, i) => toArea(a, i));
  try {
    const built = JSON.parse(localStorage.getItem(KEY(city)) || '[]') as Area[];
    return base.concat(built);
  } catch { return base; }
}

export function saveBuiltArea(city: CityConfig, area: Area) {
  try {
    const built = JSON.parse(localStorage.getItem(KEY(city)) || '[]') as Area[];
    built.push(area);
    localStorage.setItem(KEY(city), JSON.stringify(built));
  } catch { /* storage blocked: area lives for this session only */ }
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
