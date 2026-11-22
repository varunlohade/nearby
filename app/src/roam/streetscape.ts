import * as THREE from 'three';
import { hash, type Area, type Building, type Road, type XZ } from './data';

function contains(ring: XZ[], x: number, z: number) {
  let inRing = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i],
      [c, d] = ring[j];
    if (b > z !== d > z && x < ((c - a) * (z - b)) / (d - b) + a) inRing = !inRing;
  }
  return inRing;
}

// One instanced draw per populated chunk for trunks, foliage and warm lamps.
export function streetscape(
  roads: Road[],
  buildings: Building[],
  areas: Area[],
  x0: number,
  z0: number,
  size: number,
) {
  const pieces: { x: number; y: number; z: number; w: number; h: number; d: number; color: number }[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number) =>
    pieces.push({ x, y, z, w, h, d, color });
  const segments = roads.flatMap((r) =>
    r.pts.slice(1).map(([x, z], i) => ({ a: r.pts[i], dx: x - r.pts[i][0], dz: z - r.pts[i][1], width: r.width })),
  );
  const clear = (x: number, z: number, radius: number) => {
    if (buildings.some((b) => contains(b.ring, x, z))) return false;
    if (
      areas.some((a) => a.kind === 'water' && contains(a.outer, x, z) && !a.holes.some((h) => contains(h, x, z)))
    )
      return false;
    return !segments.some(({ a, dx, dz, width }) => {
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < width / 2 + radius;
    });
  };
  const tree = (x: number, z: number) => {
    const f = hash(x, z),
      h = 4.5 + f * 2;
    box(x, h * 0.27, z, 0.55, h * 0.54, 0.55, 0x735844);
    box(x, h * 0.67, z, 3.4, h * 0.52, 3.6, f > 0.5 ? 0x567e57 : 0x668453);
    box(x + 0.25, h * 0.95, z - 0.18, 2.4, h * 0.26, 2.5, 0x88a66b);
  };
  const parks = areas.filter((a) => a.kind === 'park');
  if (parks.length)
    for (let u = 9; u < size; u += 20)
      for (let v = 9; v < size; v += 20) {
        const x = x0 + u + 6 * hash(u + x0, v + z0),
          z = z0 + v + 6 * hash(v + z0, u + x0);
        if (
          parks.some((a) => contains(a.outer, x, z) && !a.holes.some((h) => contains(h, x, z))) &&
          clear(x, z, 1.8)
        )
          tree(x, z);
      }
  for (const r of roads) {
    if (!r.drivable || r.width < 7) continue;
    let next = 14;
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1],
        [bx, bz] = r.pts[i],
        length = Math.hypot(bx - ax, bz - az);
      if (!length) continue;
      const nx = (az - bz) / length,
        nz = (bx - ax) / length;
      for (; next < length; next += 36) {
        const x = ax + ((bx - ax) * next) / length,
          z = az + ((bz - az) * next) / length,
          side = r.width / 2 + 2;
        const lx = x + nx * side,
          lz = z + nz * side;
        if (clear(lx, lz, 0.15)) {
          box(lx, 3.4, lz, 0.2, 6.8, 0.2, 0x858b88);
          box(
            lx - nx * 0.55,
            6.82,
            lz - nz * 0.55,
            0.22 + Math.abs(nx) * 1.2,
            0.15,
            0.22 + Math.abs(nz) * 1.2,
            0xaeb0a3,
          );
          box(lx - nx, 6.73, lz - nz, 0.75, 0.2, 0.75, 0xffe2a0);
        }
        const tx = x - nx * (side + 1.2),
          tz = z - nz * (side + 1.2);
        if (clear(tx, tz, 1.8)) tree(tx, tz);
      }
      next -= length;
    }
  }
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial(), pieces.length);
  const obj = new THREE.Object3D(),
    color = new THREE.Color();
  pieces.forEach((p, i) => {
    obj.position.set(p.x, p.y, p.z);
    obj.scale.set(p.w, p.h, p.d);
    obj.updateMatrix();
    mesh.setMatrixAt(i, obj.matrix);
    mesh.setColorAt(i, color.setHex(p.color));
  });
  mesh.name = 'Trees and streetlights';
  return mesh;
}
