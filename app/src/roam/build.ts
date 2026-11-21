// Three.js meshes for Free Roam, in nearby's street-atlas look: charcoal ground,
// cream roads, teal water, dark buildings with warm lit windows, amber accents.
// Everything static is merged into a handful of draw calls.

import * as THREE from 'three';
import type { Area, Building, Road, XZ } from './data';

export const COLORS = {
  sky: 0x14171b, ground: 0x24272a, park: 0x2f4437, water: 0x1f3d4a, accent: 0xf5bd52,
  road: { motorway: 0xe8dcc1, trunk: 0xd4d1c4, primary: 0xd4d1c4, secondary: 0xa8a8a0, tertiary: 0x959793, minor: 0x5f6362, service: 0x4e5252, track: 0x454a47, path: 0x3f4542, raceway: 0xd4d1c4, busway: 0x6b6f6c } as Record<string, number>,
};
const ROAD_Y: Record<string, number> = { motorway: 0.09, trunk: 0.085, primary: 0.08, secondary: 0.075, tertiary: 0.07, minor: 0.06, service: 0.05, raceway: 0.08, busway: 0.055, track: 0.04, path: 0.035 };

function geometryFrom(pos: number[], idx: number[], colors?: number[], extra?: Record<string, [number[], number]>) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  for (const [name, [data, size]] of Object.entries(extra ?? {})) g.setAttribute(name, new THREE.Float32BufferAttribute(data, size));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildGround(radius: number) {
  const ground = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.6, 64), new THREE.MeshLambertMaterial({ color: COLORS.ground }));
  ground.rotation.x = -Math.PI / 2;
  // A faint ring marks the edge of the explorable area.
  const edge = new THREE.Mesh(new THREE.RingGeometry(radius - 2, radius, 128),
    new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  edge.rotation.x = -Math.PI / 2; edge.position.y = 0.12;
  const group = new THREE.Group(); group.add(ground, edge);
  return group;
}

export function buildAreas(areas: Area[]) {
  const group = new THREE.Group();
  for (const kind of ['park', 'water'] as const) {
    const pos: number[] = [], idx: number[] = [];
    const y = kind === 'water' ? 0.03 : 0.02;
    for (const a of areas.filter(a => a.kind === kind)) {
      const contour = a.outer.map(p => new THREE.Vector2(p[0], p[1]));
      const holes = a.holes.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
      let tris: number[][];
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
      const base = pos.length / 3;
      for (const p of [...contour, ...holes.flat()]) pos.push(p.x, y, p.y);
      for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
    }
    if (!idx.length) continue;
    const g = geometryFrom(pos, idx);
    group.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: kind === 'water' ? COLORS.water : COLORS.park, side: THREE.DoubleSide })));
  }
  return group;
}

/** Flat ribbons for every road, grouped by colour, plus amber lane dashes on big roads. */
export function buildRoads(roads: Road[]) {
  const byColor = new Map<number, { pos: number[]; idx: number[] }>();
  const dash = { pos: [] as number[], idx: [] as number[] };
  const quad = (out: { pos: number[]; idx: number[] }, pts: number[][]) => {
    const b = out.pos.length / 3;
    for (const p of pts) out.pos.push(p[0], p[1], p[2]);
    out.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  for (const road of roads) {
    const color = COLORS.road[road.cls] ?? COLORS.road.minor;
    const out = byColor.get(color) ?? byColor.set(color, { pos: [], idx: [] }).get(color)!;
    const y = ROAD_Y[road.cls] ?? 0.05, half = road.width / 2, pts = road.pts;
    const base = out.pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next[0] - prev[0], dz = next[1] - prev[1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      // Miter: widen at bends, but cap it so sharp turns do not spike.
      let scale = 1;
      if (i > 0 && i < pts.length - 1) {
        const ax = pts[i][0] - prev[0], az = pts[i][1] - prev[1], al = Math.hypot(ax, az) || 1;
        const cos = (ax / al) * dx + (az / al) * dz;
        scale = Math.min(1.8, 1 / Math.max(0.3, cos));
      }
      const nx = -dz * half * scale, nz = dx * half * scale;
      out.pos.push(pts[i][0] + nx, y, pts[i][1] + nz, pts[i][0] - nx, y, pts[i][1] - nz);
      if (i > 0) { const k = base + i * 2; out.idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    // Round caps at the ends of wide roads hide joins between tile pieces.
    if (road.width >= 7) for (const end of [pts[0], pts[pts.length - 1]]) {
      const c = out.pos.length / 3;
      out.pos.push(end[0], y, end[1]);
      for (let s = 0; s <= 10; s++) { const a = (s / 10) * Math.PI * 2; out.pos.push(end[0] + Math.cos(a) * half, y, end[1] + Math.sin(a) * half); }
      for (let s = 0; s < 10; s++) out.idx.push(c, c + 1 + s + 1, c + 1 + s);
    }
    if (road.width >= 10 && road.drivable) {
      let carry = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const len = Math.hypot(bx - ax, bz - az); if (!len) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        for (let d = carry; d < len; d += 9) {
          const e = Math.min(len, d + 3), w = 0.13;
          quad(dash, [[ax + ux * d - uz * w, y + 0.01, az + uz * d + ux * w], [ax + ux * e - uz * w, y + 0.01, az + uz * e + ux * w],
            [ax + ux * e + uz * w, y + 0.01, az + uz * e - ux * w], [ax + ux * d + uz * w, y + 0.01, az + uz * d - ux * w]]);
        }
        carry = (carry - len) % 9; if (carry < 0) carry += 9;
      }
    }
  }
  const group = new THREE.Group();
  for (const [color, out] of byColor) {
    const g = geometryFrom(out.pos, out.idx);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    group.add(m);
  }
  if (dash.idx.length) group.add(new THREE.Mesh(geometryFrom(dash.pos, dash.idx), new THREE.MeshBasicMaterial({ color: 0xe9c28a, side: THREE.DoubleSide })));
  return group;
}

/**
 * All buildings in one mesh. Walls carry (along, height, seed) so the shader can
 * draw a grid of windows, some lit amber; roofs get a flat lighter tone.
 * Also returns the wall segments for collisions.
 */
export function buildBuildings(buildings: Building[], windows = true) {
  const pos: number[] = [], idx: number[] = [], col: number[] = [], facade: number[] = [];
  const segments: number[] = [];
  const c = new THREE.Color();
  for (const b of buildings) {
    const ring = b.ring, n = ring.length, h = b.height;
    // Outward direction: compare each edge's right-hand normal with the centroid.
    let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= n; cz /= n;
    let vote = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], q = ring[(i + 1) % n];
      vote += (q[1] - a[1]) * ((a[0] + q[0]) / 2 - cx) - (q[0] - a[0]) * ((a[1] + q[1]) / 2 - cz);
    }
    const flip = vote < 0;
    c.setHex(b.color);
    let along = 0;
    for (let i = 0; i < n; i++) {
      let a = ring[i], q = ring[(i + 1) % n];
      if (flip) [a, q] = [q, a];
      const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      segments.push(a[0], a[1], q[0], q[1]);
      const base = pos.length / 3;
      pos.push(a[0], 0, a[1], q[0], 0, q[1], q[0], h, q[1], a[0], h, a[1]);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
      facade.push(along, 0, b.seed + 0.01, along + len, 0, b.seed + 0.01, along + len, h, b.seed + 0.01, along, h, b.seed + 0.01);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      along += len;
    }
    // Roof.
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(ring.map(p => new THREE.Vector2(p[0], p[1])), []); } catch { continue; }
    const base = pos.length / 3;
    const roof = c.clone().offsetHSL(0, -0.05, 0.08);
    for (const p of ring) { pos.push(p[0], h, p[1]); col.push(roof.r, roof.g, roof.b); facade.push(0, 0, 0); }
    for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
  }
  const g = geometryFrom(pos, idx, col, { aFacade: [facade, 3] });
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  if (windows) material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFacade;\nvarying vec3 vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = aFacade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFacade;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vFacade.z > 0.0) {
          vec2 cell = vec2(vFacade.x / 3.3, vFacade.y / 3.3);
          vec2 f = fract(cell);
          float win = step(0.3, f.x) * step(f.x, 0.7) * step(0.38, f.y) * step(f.y, 0.74) * step(1.0, cell.y);
          float h = fract(sin(dot(floor(cell) + vFacade.z * 17.3, vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5, win);
          totalEmissiveRadiance += win * step(0.68, h) * mix(vec3(1.0, 0.7, 0.36), vec3(0.7, 0.8, 0.95), step(0.94, h)) * (0.45 + 0.25 * fract(h * 7.0));
          diffuseColor.rgb *= 0.86 + 0.14 * smoothstep(0.0, 6.0, vFacade.y);
        }`);
  };
  return { mesh: new THREE.Mesh(g, material), segments: new Float32Array(segments) };
}

/** A small, friendly car: body, cabin, wheels, head and tail lights. Forward is -z. */
export function makeCar(color: number) {
  const car = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.22) });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1a1c1f });
  const glass = new THREE.MeshLambertMaterial({ color: 0x2c3d47, emissive: 0x0b1418 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 4.3), paint); body.position.y = 0.62;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.58, 2.2), glass); cabin.position.set(0, 1.23, 0.25);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 1.9), paint); roof.position.set(0, 1.55, 0.3);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 4.31), dark); stripe.position.set(0, 0.98, 0);
  car.add(body, cabin, roof, stripe);
  const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14); wheel.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.9, -1.35], [0.9, -1.35], [-0.9, 1.35], [0.9, 1.35]]) {
    const w = new THREE.Mesh(wheel, dark); w.position.set(x, 0.36, z); w.name = z < 0 ? 'front-wheel' : 'rear-wheel'; car.add(w);
  }
  const head = new THREE.MeshBasicMaterial({ color: 0xfff4d6 }), tail = new THREE.MeshBasicMaterial({ color: 0xff5a4a });
  for (const x of [-0.62, 0.62]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), head); h.position.set(x, 0.72, -2.16); car.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.05), tail); t.position.set(x, 0.74, 2.16); t.name = 'tail'; car.add(t);
  }
  return car;
}

/** Instanced traffic: bodies and cabins. */
export function makeTraffic(count: number) {
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1.85, 0.75, 4.2).translate(0, 0.62, 0), new THREE.MeshLambertMaterial(), count);
  const cabin = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.56, 2.1).translate(0, 1.25, 0.25),
    new THREE.MeshLambertMaterial({ color: 0x2c3d47, emissive: 0x0b1418 }), count);
  const lights = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.12, 0.06).translate(0, 0.74, 2.12), new THREE.MeshBasicMaterial({ color: 0xff5a4a }), count);
  return { body, cabin, lights };
}

export function makeWalker() {
  const g = new THREE.Group();
  const coat = new THREE.MeshLambertMaterial({ color: 0x7fd9c4 }), skin = new THREE.MeshLambertMaterial({ color: 0xd9a77c });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.75, 4, 10), coat); body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), skin); head.position.y = 1.62;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.22), new THREE.MeshLambertMaterial({ color: 0x2b2f38 })); legs.position.y = 0.3;
  g.add(body, head, legs);
  return g;
}

/** A tall soft light column marking a place you can visit. */
export function makeBeacon(color: number, height = 70) {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { color: { value: new THREE.Color(color) }, time: { value: 0 }, strength: { value: 1 } },
    vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 color; uniform float time; uniform float strength; varying float vY;
      void main(){ float a = (1.0 - vY) * (0.55 + 0.25 * sin(time * 2.5 - vY * 8.0)) * strength; gl_FragColor = vec4(color * a, a); }`,
  });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, height, 18, 1, true).translate(0, height / 2, 0), material);
  const ring = new THREE.Mesh(new THREE.RingGeometry(3, 4.2, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2;
  const g = new THREE.Group(); g.add(column, ring);
  return { group: g, material, ring };
}

/** GPS route: a glowing ribbon with chevrons that flow toward the destination. */
export function makeRoute(points: XZ[]) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (i > 0) along += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    const w = 1.5;
    pos.push(points[i][0] - dz * w, 0.32, points[i][1] + dx * w, points[i][0] + dz * w, 0.32, points[i][1] - dx * w);
    uv.push(along, 0, along, 1);
    if (i > 0) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(COLORS.accent) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float time; uniform vec3 color; varying vec2 vUv;
      void main(){
        float across = abs(vUv.y - 0.5) * 2.0;
        float chevron = fract((vUv.x - across * 2.0) / 7.0 - time * 1.2);
        float a = 0.55 + 0.45 * step(0.55, chevron);
        a *= 1.0 - smoothstep(0.8, 1.0, across);
        gl_FragColor = vec4(mix(color, vec3(1.0, 0.97, 0.88), step(0.55, chevron) * 0.5), a * 0.9);
      }`,
  });
  return new THREE.Mesh(g, material);
}

export function makeSparks(count = 90) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  // Soft round dots (a radial gradient), not square points.
  const dot = document.createElement('canvas'); dot.width = dot.height = 32;
  const g = dot.getContext('2d')!, grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,.7)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffc56b, size: 0.45, map: new THREE.CanvasTexture(dot), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  points.frustumCulled = false;
  return points;
}
