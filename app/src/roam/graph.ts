// Road network for Free Roam: a graph of the drivable streets, with spatial
// lookups (nearest road, nearest node), A* routing for the GPS line, and the
// edges traffic cars follow.

import type { Road, XZ } from './data';

export interface Edge { a: number; b: number; len: number; width: number; cls: string; bridge?: boolean }

/** Minimal binary heap keyed by priority (smallest first). */
class Heap {
  private items: [number, number][] = [];
  get size() { return this.items.length; }
  push(item: [number, number]) {
    const a = this.items; a.push(item);
    for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const RANK: Record<string, number> = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, minor: 1, service: 0 };

export class RoadGraph {
  nodes: XZ[] = [];
  edges: Edge[] = [];
  /** node -> edge indices */
  adj: number[][] = [];
  private nodeKey = new Map<string, number>();
  private edgeGrid = new Map<string, number[]>();
  private readonly cell = 40;

  constructor(roads: Road[]) {
    for (const road of roads) {
      if (!road.drivable) continue;
      for (let i = 1; i < road.pts.length; i++) {
        const a = this.node(road.pts[i - 1]), b = this.node(road.pts[i]);
        if (a === b) continue;
        const [ax, az] = this.nodes[a], [bx, bz] = this.nodes[b];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const e = this.edges.push({ a, b, len, width: road.width, cls: road.cls, bridge:road.bridge }) - 1;
        this.adj[a].push(e); this.adj[b].push(e);
      }
    }
    this.joinLooseEnds();
    this.edges.forEach((e, i) => this.indexEdge(i, e));
  }

  private node(p: XZ) {
    const key = Math.round(p[0]) + ',' + Math.round(p[1]);
    let id = this.nodeKey.get(key);
    if (id === undefined) { id = this.nodes.push([p[0], p[1]]) - 1; this.adj.push([]); this.nodeKey.set(key, id); }
    return id;
  }

  /** Tile borders and simplification leave road ends a few metres apart: connect them. */
  private joinLooseEnds() {
    const grid = new Map<string, number[]>();
    const k = (x: number, z: number) => Math.floor(x / 8) + ',' + Math.floor(z / 8);
    this.nodes.forEach((p, i) => { const key = k(p[0], p[1]); (grid.get(key) ?? grid.set(key, []).get(key)!).push(i); });
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.adj[i].length !== 1) continue;
      const [x, z] = this.nodes[i];
      let best = -1, bestD = 6;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get((Math.floor(x / 8) + dx) + ',' + (Math.floor(z / 8) + dz)) ?? []) {
          if (j === i || this.adj[i].some(e => this.edges[e].a === j || this.edges[e].b === j)) continue;
          const d = Math.hypot(this.nodes[j][0] - x, this.nodes[j][1] - z);
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      if (best >= 0) {
        const e = this.edges.push({ a: i, b: best, len: Math.max(0.6, bestD), width: this.edges[this.adj[i][0]].width, cls: this.edges[this.adj[i][0]].cls }) - 1;
        this.adj[i].push(e); this.adj[best].push(e);
      }
    }
  }

  private indexEdge(i: number, e: Edge) {
    const [ax, az] = this.nodes[e.a], [bx, bz] = this.nodes[e.b];
    const steps = Math.max(1, Math.ceil(e.len / (this.cell / 2)));
    const cells = new Set<string>();
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      cells.add(Math.floor((ax + (bx - ax) * t) / this.cell) + ',' + Math.floor((az + (bz - az) * t) / this.cell));
    }
    for (const c of cells) (this.edgeGrid.get(c) ?? this.edgeGrid.set(c, []).get(c)!).push(i);
  }

  other(e: Edge, n: number) { return e.a === n ? e.b : e.a; }
  rank(e: Edge) { return RANK[e.cls] ?? 0; }

  /** Closest point on any drivable road. */
  nearest(x: number, z: number, maxDist = 400): { edge: number; t: number; point: XZ; dist: number } | null {
    type Hit = { edge: number; t: number; point: XZ; dist: number };
    let best = null as Hit | null;
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let ring = 0; ring * this.cell <= maxDist + this.cell; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        for (const i of this.edgeGrid.get((cx + dx) + ',' + (cz + dz)) ?? []) {
          const e = this.edges[i];
          const [ax, az] = this.nodes[e.a], [bx, bz] = this.nodes[e.b];
          const vx = bx - ax, vz = bz - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
          const px = ax + vx * t, pz = az + vz * t;
          const d = Math.hypot(x - px, z - pz);
          if (!best || d < best.dist) best = { edge: i, t, point: [px, pz], dist: d };
        }
      }
      if (best && best.dist < ring * this.cell) break;
    }
    return best && best.dist <= maxDist ? best : null;
  }

  /** A good place to start: a well-connected road point near (x, z). */
  spawnNear(x: number, z: number): { point: XZ; heading: number } | null {
    const hit = this.nearest(x, z, 1500);
    if (!hit) return null;
    let e = this.edges[hit.edge];
    // Avoid dead ends: prefer an edge whose ends both connect onward.
    if (this.adj[e.a].length < 2 || this.adj[e.b].length < 2) {
      const alt = [...this.adj[e.a], ...this.adj[e.b]].map(i => this.edges[i]).find(o => this.adj[o.a].length > 1 && this.adj[o.b].length > 1);
      if (alt) e = alt;
    }
    const [ax, az] = this.nodes[e.a], [bx, bz] = this.nodes[e.b];
    const t = e === this.edges[hit.edge] ? hit.t : 0.5;
    return { point: [ax + (bx - ax) * t, az + (bz - az) * t], heading: Math.atan2(bx - ax, -(bz - az)) };
  }

  /** A* over the road graph from the road point nearest `from` to the one nearest `to`. */
  route(from: XZ, to: XZ): XZ[] | null {
    const start = this.nearest(from[0], from[1]), goal = this.nearest(to[0], to[1], 600);
    if (!start || !goal) return null;
    const s = this.edges[start.edge], g = this.edges[goal.edge];
    const goalNodes = new Set([g.a, g.b]);
    const target = goal.point;
    const h = (n: number) => Math.hypot(this.nodes[n][0] - target[0], this.nodes[n][1] - target[1]);
    const dist = new Map<number, number>(), prev = new Map<number, number>();
    const open = new Heap();
    const push = (n: number, d: number, from: number) => {
      if (d >= (dist.get(n) ?? Infinity)) return;
      dist.set(n, d); prev.set(n, from);
      open.push([d + h(n), n]);
    };
    push(s.a, Math.hypot(this.nodes[s.a][0] - start.point[0], this.nodes[s.a][1] - start.point[1]), -1);
    push(s.b, Math.hypot(this.nodes[s.b][0] - start.point[0], this.nodes[s.b][1] - start.point[1]), -1);
    let reached = -1, guard = 0;
    const closed = new Set<number>();
    while (open.size && guard++ < 200000) {
      const [, n] = open.pop();
      if (closed.has(n)) continue;
      closed.add(n);
      if (goalNodes.has(n)) { reached = n; break; }
      const d = dist.get(n)!;
      for (const ei of this.adj[n]) {
        const e = this.edges[ei];
        // Small bias towards bigger roads, like a sat-nav.
        push(this.other(e, n), d + e.len * (1.15 - this.rank(e) * 0.03), n);
      }
    }
    if (reached < 0) return null;
    const path: XZ[] = [target];
    for (let n = reached; n >= 0; n = prev.get(n) ?? -1) path.push(this.nodes[n]);
    path.push(start.point);
    return path.reverse();
  }
}
