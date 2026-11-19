// The map: MapLibre GL JS on keyless OpenFreeMap tiles, with deck.gl effects drawn inside the 3D scene.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import style from './style.json';
import { distKm, ringAround } from '../areas';
import type { Area, CityConfig, Happening, LatLng } from '../types';
import type { MapView } from './types';

const ACCENT = '#FFB224';
type RGB = [number, number, number];
const GLOW = { depthCompare: 'always', blend: true, blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one' } as any;
const COLOR: Record<Happening['kind'], RGB> = {
  concert: [255, 92, 170], market: [140, 230, 90], match: [80, 160, 255], ride: [60, 230, 230], help: [255, 110, 70], joined: [255, 178, 36],
};
type XY = [number, number];

interface Live { h: Happening; born: number; phase: number; path?: XY[]; tries: number; dying?: number; targetCenter?: LatLng }

// ---------- roads from the vector tiles, so paths follow real streets ----------
function roadNear(map: maplibregl.Map, at: LatLng, maxKm: number): XY[] | null {
  const feats = map.querySourceFeatures('omt', { sourceLayer: 'transportation',
    filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'minor', 'trunk'], true, false] });
  let best: { line: XY[]; i: number; d: number } | null = null;
  for (const f of feats) {
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines as XY[][]) {
      line.forEach((c, i) => {
        const d = distKm(at, { lat: c[1], lng: c[0] });
        if (d < maxKm && line.length > 2 && (!best || d < best.d)) best = { line, i, d };
      });
    }
  }
  if (!best) return null;
  const { line, i } = best as { line: XY[]; i: number };
  // Walk the longer side from the nearest vertex.
  const fwd = line.slice(i), back = line.slice(0, i + 1).reverse();
  return fwd.length >= back.length ? fwd : back;
}

function trimKm(path: XY[], km: number): XY[] {
  const out: XY[] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length && acc < km; i++) {
    acc += distKm({ lat: path[i - 1][1], lng: path[i - 1][0] }, { lat: path[i][1], lng: path[i][0] });
    out.push(path[i]);
  }
  return out;
}

const pathKm = (p: XY[]) => p.slice(1).reduce((acc, c, i) => acc + distKm({ lat: p[i][1], lng: p[i][0] }, { lat: c[1], lng: c[0] }), 0);

const loopAround = (at: LatLng, km: number): XY[] => ringAround(at, km, 0.7, 14).map((p) => [p.lng, p.lat]);

export async function createMap(el: HTMLElement, city: CityConfig, mobile: boolean): Promise<MapView> {
  const map = new maplibregl.Map({
    container: el, style: style as unknown as maplibregl.StyleSpecification, attributionControl: false,
    center: [city.center.lng, city.center.lat], zoom: 9, pitch: 0, bearing: 0, maxPitch: 72, fadeDuration: 0,
  });
  await new Promise<void>((r) => map.once('load', () => r()));

  // ---------- areas: tinted floor, glow line, light wall ----------
  const areas = new Map<string, { area: Area; mine: boolean }>();
  const busy = (a: Area) => Math.min(1, a.hereNow / 220);
  const fc = (walls: boolean) => ({
    type: 'FeatureCollection' as const,
    features: [...areas.values()].map(({ area, mine }) => {
      const outer = area.ring.map((p) => [p.lng, p.lat]);
      // Wall = thin ring just inside the outline.
      const inner = area.ring.map((p) => [area.center.lng + (p.lng - area.center.lng) * 0.985, area.center.lat + (p.lat - area.center.lat) * 0.985]).reverse();
      return { type: 'Feature' as const, properties: { mine: mine ? 1 : 0, busy: busy(area) },
        geometry: { type: 'Polygon' as const, coordinates: walls ? [outer, inner] : [outer] } };
    }),
  });
  map.addSource('areas', { type: 'geojson', data: fc(false) });
  map.addSource('walls', { type: 'geojson', data: fc(true) });
  const byMine = (a: unknown, b: unknown) => ['case', ['==', ['get', 'mine'], 1], a, b] as maplibregl.ExpressionSpecification;
  map.addLayer({ id: 'area-fill', type: 'fill', source: 'areas', paint: {
    'fill-color': byMine('#F3F4F6', ACCENT), 'fill-opacity': byMine(0.07, ['+', 0.03, ['*', ['get', 'busy'], 0.08]]) } }, 'label-road');
  map.addLayer({ id: 'area-halo', type: 'line', source: 'areas', paint: {
    'line-color': byMine('#F3F4F6', ACCENT), 'line-width': ['+', 4, ['*', ['get', 'busy'], 10]], 'line-blur': 8, 'line-opacity': 0.3 } }, 'label-road');
  map.addLayer({ id: 'area-line', type: 'line', source: 'areas', paint: {
    'line-color': byMine('#F3F4F6', ACCENT), 'line-width': 1.6, 'line-opacity': 0.9 } }, 'label-road');
  map.addLayer({ id: 'area-walls', type: 'fill-extrusion', source: 'walls', paint: {
    'fill-extrusion-color': byMine('#F3F4F6', ACCENT),
    'fill-extrusion-height': byMine(60, ['+', 40, ['*', ['get', 'busy'], 240]]),
    'fill-extrusion-opacity': 0.55, 'fill-extrusion-vertical-gradient': false } });

  // ---------- deck.gl effects, interleaved so buildings hide what is behind them ----------
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);
  const live = new Map<string, Live>();
  const labels = new Map<string, maplibregl.Marker>();
  let lastMarkerClick = 0;

  const ll = (p: LatLng): XY => [p.lng, p.lat];
  function frame(now: number) {
    const t = now / 1000;
    const rows = [...live.values()];
    const alive = (l: Live) => {
      const inT = Math.min(1, (now - l.born) / 700);
      const outT = l.dying ? Math.max(0, 1 - (now - l.dying) / 450) : 1;
      return inT * outT;
    };
    const of = (k: Happening['kind']) => rows.filter((l) => l.h.kind === k);
    for (const l of rows) {
      if (!l.path && (l.h.kind === 'ride' || l.h.kind === 'market') && l.tries < 6 && now - l.born > l.tries * 1000) {
        l.tries++;
        const road = roadNear(map, l.h.at, l.h.kind === 'ride' ? 0.6 : 0.3);
        const trimmed = road && trimKm(road, l.h.kind === 'ride' ? 1.8 : 0.6);
        // A short road piece reads as a dot; a ride then gets a loop around the spot instead.
        if (trimmed && (l.h.kind === 'market' || pathKm(trimmed) > 0.6)) l.path = trimmed;
        if (!l.path && l.tries >= 6) l.path = l.h.kind === 'ride' ? loopAround(l.h.at, 0.45) : [ll(l.h.at), [l.h.at.lng + 0.003, l.h.at.lat]];
      }
    }
    const pulse = (l: Live, period: number) => ((t + l.phase) / period) % 1;
    const rings = (k: Happening['kind'], period: number, maxR: number, n: number) => of(k).flatMap((l) =>
      Array.from({ length: n }, (_, i) => { const p = (pulse(l, period) + i / n) % 1; return { at: ll(l.h.at), r: 20 + p * maxR, a: (1 - p) * 220 * alive(l), c: COLOR[k] }; }));

    const layers: Layer[] = [
      // match: the ground lights up around the venue
      new ScatterplotLayer({ id: 'match-ground', data: of('match'), getPosition: (l: Live) => ll(l.h.at), getRadius: 480,
        getFillColor: (l: Live) => [...COLOR.match, (70 + 50 * Math.sin((t + l.phase) * 3)) * alive(l)] as any, stroked: true,
        getLineColor: (l: Live) => [...COLOR.match, 230 * alive(l)] as any, lineWidthMinPixels: 3, updateTriggers: { getFillColor: t, getLineColor: t }, parameters: GLOW }),
      new ScatterplotLayer({ id: 'pulse-rings', data: [...rings('concert', 1.6, 950, 3), ...rings('help', 1.1, 380, 2), ...rings('match', 2.4, 600, 1)],
        getPosition: (d: any) => d.at, getRadius: (d: any) => d.r, filled: false, stroked: true, lineWidthMinPixels: 3,
        getLineColor: (d: any) => [...d.c, d.a] as any, parameters: GLOW }),
      // market: glowing strip along the street
      new PathLayer({ id: 'market-glow', data: of('market').filter((l) => l.path), getPath: (l: Live) => l.path!, getWidth: 70, widthMinPixels: 12,
        capRounded: true, parameters: GLOW, getColor: (l: Live) => [...COLOR.market, (60 + 30 * Math.sin((t + l.phase) * 2.5)) * alive(l)] as any, updateTriggers: { getColor: t } }),
      new PathLayer({ id: 'market-core', data: of('market').filter((l) => l.path), getPath: (l: Live) => l.path!, getWidth: 18, widthMinPixels: 4,
        capRounded: true, getColor: (l: Live) => [210, 255, 170, 240 * alive(l)] as any, updateTriggers: { getColor: t } }),
      // run / ride: faint route plus a moving light trail
      new PathLayer({ id: 'ride-route', data: of('ride').filter((l) => l.path), getPath: (l: Live) => l.path!, getWidth: 14, widthMinPixels: 3,
        getColor: (l: Live) => [...COLOR.ride, 110 * alive(l)] as any, updateTriggers: { getColor: t } }),
      new TripsLayer({ id: 'ride-trail', data: of('ride').filter((l) => l.path), getPath: (l: Live) => l.path!,
        getTimestamps: (l: Live) => l.path!.map((_, i) => i * (100 / Math.max(1, l.path!.length - 1))),
        getColor: COLOR.ride, widthMinPixels: 7, capRounded: true, jointRounded: true, trailLength: 35, fadeTrail: true,
        currentTime: ((t * 22) % 135), parameters: GLOW }),
    ];
    // concert: a light beam from the venue; help: a small blinking beacon
    layers.push(
      new ColumnLayer({ id: 'concert-beam', data: of('concert'), parameters: GLOW, diskResolution: 20, extruded: true, material: false, radius: 70,
        getPosition: (l: Live) => ll(l.h.at), getElevation: (l: Live) => 2400 * alive(l),
        getFillColor: (l: Live) => [...COLOR.concert, (90 + 50 * Math.sin((t + l.phase) * 6)) * alive(l)] as any, updateTriggers: { getFillColor: t, getElevation: t } }),
      new ColumnLayer({ id: 'concert-core', data: of('concert'), diskResolution: 12, extruded: true, material: false, radius: 22,
        getPosition: (l: Live) => ll(l.h.at), getElevation: (l: Live) => 2420 * alive(l),
        getFillColor: (l: Live) => [255, 220, 240, 230 * alive(l)] as any, updateTriggers: { getFillColor: t, getElevation: t } }),
      new ColumnLayer({ id: 'help-beacon', data: of('help'), parameters: GLOW, diskResolution: 12, extruded: true, material: false, radius: 40,
        getPosition: (l: Live) => ll(l.h.at), getElevation: (l: Live) => 900 * alive(l),
        getFillColor: (l: Live) => [...COLOR.help, (120 + 120 * (0.5 + 0.5 * Math.sin((t + l.phase) * 6))) * alive(l)] as any, updateTriggers: { getFillColor: t, getElevation: t } }),
    );
    // people joined: particles streaming in from outside towards the area centre
    const parts = of('joined').flatMap((l) => {
      const c = l.targetCenter ?? l.h.at;
      return Array.from({ length: 36 }, (_, i) => {
        const ang = i * 2.39996 + l.phase, p = ((t * 0.45 + i / 36 + l.phase) % 1);
        const r0 = 1.6 * (1 - p);
        return { at: [c.lng + Math.cos(ang) * r0 / (111.3 * Math.cos((c.lat * Math.PI) / 180)), c.lat + Math.sin(ang) * r0 / 110.6] as XY, a: Math.sin(p * Math.PI) * 255 * alive(l) };
      });
    });
    layers.push(new ScatterplotLayer({ id: 'joined-particles', data: parts, getPosition: (d: any) => d.at, getRadius: 26, radiusMinPixels: 3.5,
      getFillColor: (d: any) => [...COLOR.joined, d.a] as any, parameters: GLOW }));

    overlay.setProps({ layers });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Intro: from high above, fly down and tilt.
  const pad = mobile ? { top: 60, bottom: 230, left: 0, right: 0 } : { left: 360, top: 0, right: 0, bottom: 0 };
  map.flyTo({ center: [city.center.lng, city.center.lat], zoom: city.zoom, pitch: 62, bearing: city.heading,
    duration: 4200, curve: 1.6, essential: true, padding: pad });

  return {
    setArea(area, mine) {
      areas.set(area.id, { area, mine });
      (map.getSource('areas') as maplibregl.GeoJSONSource).setData(fc(false));
      (map.getSource('walls') as maplibregl.GeoJSONSource).setData(fc(true));
      labels.get(area.id)?.remove();
      const lab = document.createElement('div');
      lab.className = mine ? 'youare' : 'alabel';
      lab.innerHTML = mine ? `You're in ${area.name}` : `<b>${area.name}</b><span>${area.hereNow} here now</span>`;
      labels.set(area.id, new maplibregl.Marker({ element: lab, anchor: 'bottom' }).setLngLat([area.center.lng, area.center.lat]).addTo(map));
    },
    addHappening(h, html, onClick) {
      const area = [...areas.values()].find((a) => a.area.id === h.areaId)?.area;
      const l: Live = { h, born: performance.now(), phase: Math.random() * 10, tries: 0, targetCenter: area?.center };
      live.set(h.id, l);
      const el = document.createElement('div');
      el.className = `pop k-${h.kind}`;
      el.innerHTML = `<div class="in">${html}</div>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); lastMarkerClick = Date.now(); onClick(); });
      const m = new maplibregl.Marker({ element: el, anchor: 'left', offset: [16, -18] }).setLngLat([h.at.lng, h.at.lat]).addTo(map);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
      return () => {
        l.dying = performance.now();
        el.classList.add('out');
        setTimeout(() => { m.remove(); live.delete(h.id); }, 450);
      };
    },
    onMapClick(cb) {
      map.on('click', (e) => { if (Date.now() - lastMarkerClick > 300) cb({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
    },
    flyTo(at, close = false) {
      map.flyTo({ center: [at.lng, at.lat], zoom: close ? 15 : Math.max(map.getZoom(), 13.4), pitch: 62, duration: 1200, essential: true });
    },
    project(at) { return map.project([at.lng, at.lat]); },
    onMove(cb) { map.on('move', cb); },
  };
}
