// Spring simulators for smooth character velocity, turning and camera follow.
//
// Ported from Sketchbook by swift502 (https://github.com/swift502/Sketchbook),
// MIT License, Copyright (c) 2020 swift502:
//   src/ts/physics/spring_simulation/{SimulatorBase, SpringSimulator,
//   VectorSpringSimulator, RelativeSpringSimulator}.ts and the spring()/springV()
//   helpers in src/ts/core/FunctionLibrary.ts.
// Changes: rewritten to avoid per-frame allocations (fixed two-frame buffers),
// and a plain {x, z} vector instead of THREE.Vector3.
//
// The simulators step a damped spring at a fixed rate (default 60 Hz) and
// interpolate between the last two steps, so the motion is identical at any
// frame rate.

/** One spring step (Sketchbook's spring()). */
function step(position: number, target: number, velocity: number, mass: number, damping: number): [number, number] {
  velocity = (velocity + (target - position) / mass) * damping;
  return [position + velocity, velocity];
}

abstract class FixedRate {
  protected offset = 0;
  protected readonly frameTime: number;
  constructor(fps: number, public mass: number, public damping: number) { this.frameTime = 1 / fps; }
  /** Number of fixed frames to run for this time step (capped so a long hitch cannot spiral). */
  protected frames(dt: number) {
    const total = this.offset + Math.min(dt, 0.25);
    const n = Math.floor(total / this.frameTime);
    this.offset = total - n * this.frameTime;
    return n;
  }
  protected get alpha() { return this.offset / this.frameTime; }
}

/** Scalar spring (SpringSimulator). */
export class Spring extends FixedRate {
  position: number; velocity: number; target: number;
  private p0: number; private p1: number; private v0: number; private v1: number;
  constructor(fps: number, mass: number, damping: number, start = 0) {
    super(fps, mass, damping);
    this.position = this.target = this.p0 = this.p1 = start;
    this.velocity = this.v0 = this.v1 = 0;
  }
  simulate(dt: number) {
    for (let i = this.frames(dt); i > 0; i--) {
      const [p, v] = step(this.p1, this.target, this.v1, this.mass, this.damping);
      this.p0 = this.p1; this.v0 = this.v1; this.p1 = p; this.v1 = v;
    }
    this.position = this.p0 + (this.p1 - this.p0) * this.alpha;
    this.velocity = this.v0 + (this.v1 - this.v0) * this.alpha;
  }
  reset(value: number) { this.position = this.target = this.p0 = this.p1 = value; this.velocity = this.v0 = this.v1 = 0; }
}

/** 2D vector spring on the ground plane (VectorSpringSimulator). */
export class VectorSpring extends FixedRate {
  x = 0; z = 0; vx = 0; vz = 0;
  tx = 0; tz = 0;
  private px0 = 0; private pz0 = 0; private px1 = 0; private pz1 = 0;
  private vx0 = 0; private vz0 = 0; private vx1 = 0; private vz1 = 0;
  simulate(dt: number) {
    for (let i = this.frames(dt); i > 0; i--) {
      const [x, vx] = step(this.px1, this.tx, this.vx1, this.mass, this.damping);
      const [z, vz] = step(this.pz1, this.tz, this.vz1, this.mass, this.damping);
      this.px0 = this.px1; this.pz0 = this.pz1; this.vx0 = this.vx1; this.vz0 = this.vz1;
      this.px1 = x; this.pz1 = z; this.vx1 = vx; this.vz1 = vz;
    }
    const a = this.alpha;
    this.x = this.px0 + (this.px1 - this.px0) * a; this.z = this.pz0 + (this.pz1 - this.pz0) * a;
    this.vx = this.vx0 + (this.vx1 - this.vx0) * a; this.vz = this.vz0 + (this.vz1 - this.vz0) * a;
  }
  reset(x = 0, z = 0) {
    this.x = this.tx = this.px0 = this.px1 = x; this.z = this.tz = this.pz0 = this.pz1 = z;
    this.vx = this.vz = this.vx0 = this.vz0 = this.vx1 = this.vz1 = 0;
  }
}

/**
 * Relative spring for turning (RelativeSpringSimulator): `target` is the signed
 * angle still to turn; `position` is how much to turn this frame.
 */
export class RelativeSpring extends FixedRate {
  position = 0; velocity = 0; target = 0;
  private f0v = 0; private f1p = 0; private f1v = 0; private lastLerp = 0;
  simulate(dt: number) {
    const n = this.frames(dt);
    for (let i = 1; i <= n; i++) {
      let p = this.f1p;
      if (i === n) { p = 0; this.lastLerp -= this.f1p; }   // re-base on the last generated frame
      const [np, nv] = step(p, this.target, this.f1v, this.mass, this.damping);
      this.f0v = this.f1v; this.f1p = np; this.f1v = nv;
    }
    const lerp = this.f1p * this.alpha;
    this.position = lerp - this.lastLerp;
    this.lastLerp = lerp;
    this.velocity = this.f0v + (this.f1v - this.f0v) * this.alpha;
  }
}
