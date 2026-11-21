// Cars with real rigid-body physics (cannon-es, MIT).
//
// The drivable car is a cannon-es RaycastVehicle. Its numbers come from
// proven open-source browser games rather than tuning by feel:
//   - pmndrs/racing-game (MIT, github.com/pmndrs/racing-game, src/store.ts and
//     src/models/vehicle/*): chassis mass 500, box 2 x 1.1 x 4.7, wheel radius
//     0.38, suspension stiffness 30, rest length 0.35, friction slip 1.5, side
//     acceleration 3, wheel layout (width 1.7, front 1.35, back -1.3, height -0.3),
//     steer 0.3 rad, engine force 1800, brake 65, and the lerp(…, delta * 20)
//     smoothing of engine and steering.
//   - Bruno Simon's folio-2019 (MIT, src/javascript/World/Physics.js): custom
//     sliding wheel rotation (-30), roll influence 0.01 against tipping in city
//     crashes, and the wheel/ground contact friction 0.3.
// Changes: forward is -z to match our meshes, and the handbrake lowers rear grip
// for a drift (a common arcade trick).

import * as CANNON from 'cannon-es';
import type * as THREE from 'three';

export const CAR = {
  mass: 500, half: new CANNON.Vec3(1, 0.55, 2.35),
  width: 1.7, height: -0.3, front: -1.35, back: 1.3,   // front at -z
  steer: 0.3, force: 1800, maxBrake: 65, maxSpeed: 30,  // m/s (~108 km/h) for city streets
  wheel: {
    radius: 0.38, suspensionStiffness: 30, suspensionRestLength: 0.35, frictionSlip: 1.5, sideAcceleration: 3,
    dampingRelaxation: 2.3, dampingCompression: 4.4, maxSuspensionForce: 100000, rollInfluence: 0.01,
    maxSuspensionTravel: 0.3, customSlidingRotationalSpeed: -30, useCustomSlidingRotationalSpeed: true,
  },
};

export class Vehicle {
  readonly body: CANNON.Body;
  readonly raycast: CANNON.RaycastVehicle;
  driver: 'player' | 'none' = 'none';
  engine = 0;
  steering = 0;
  /** Seconds spent upside down or on its side, for auto-recovery. */
  tipped = 0;
  /** Sinking after driving into water. */
  sinking = 0;
  readonly lastDry = new CANNON.Vec3();
  lastDryYaw = 0;

  constructor(private world: CANNON.World, readonly mesh: THREE.Object3D, readonly color: number, readonly grip = 1) {
    this.body = new CANNON.Body({ mass: CAR.mass, angularDamping: 0.4, linearDamping: 0.05, allowSleep: true, sleepSpeedLimit: 0.3, sleepTimeLimit: 2 });
    this.body.addShape(new CANNON.Box(CAR.half), new CANNON.Vec3(0, 0.25, 0));
    this.raycast = new CANNON.RaycastVehicle({ chassisBody: this.body, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2 });
    const w = CAR.wheel;
    for (const [x, z] of [[-CAR.width / 2, CAR.front], [CAR.width / 2, CAR.front], [-CAR.width / 2, CAR.back], [CAR.width / 2, CAR.back]]) {
      this.raycast.addWheel({
        ...w, frictionSlip: w.frictionSlip * grip,
        directionLocal: new CANNON.Vec3(0, -1, 0), axleLocal: new CANNON.Vec3(-1, 0, 0),
        chassisConnectionPointLocal: new CANNON.Vec3(x, CAR.height, z),
      });
    }
    this.raycast.addToWorld(world);
  }

  /** Place on the ground at (x, z) facing `heading` (0 = north, -z). */
  place(x: number, z: number, heading: number) {
    this.body.position.set(x, 1.0, z);
    this.body.quaternion.setFromEuler(0, -heading, 0);
    this.body.velocity.setZero(); this.body.angularVelocity.setZero();
    this.engine = this.steering = 0; this.tipped = 0; this.sinking = 0;
    this.lastDry.copy(this.body.position); this.lastDryYaw = heading;
    this.body.wakeUp();
  }

  get x() { return this.body.position.x; }
  get z() { return this.body.position.z; }
  /** Heading in our convention: 0 = north (-z), clockwise positive. */
  get heading() {
    const q = this.body.quaternion;
    const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    return Math.atan2(fx, -fz);
  }
  get speed() { return this.body.velocity.length(); }
  /** Signed speed along the car's forward axis. */
  get forwardSpeed() { const h = this.heading; return this.body.velocity.x * Math.sin(h) - this.body.velocity.z * Math.cos(h); }
  get upright() { const q = this.body.quaternion; return 1 - 2 * (q.x * q.x + q.z * q.z); }

  /**
   * Drive (racing-game style): throttle -1..1, steer -1..1 (right positive).
   * Engine and steering ease toward their targets; brake on the rear wheels.
   */
  drive(throttle: number, steer: number, handbrake: boolean, dt: number) {
    const speed = this.forwardSpeed;
    const reversing = throttle < 0 && speed < 1;
    const braking = throttle < 0 && speed > 1;
    const k = Math.min(1, dt * 20);
    this.engine += ((braking ? 0 : throttle * CAR.force * (reversing ? 0.55 : 1)) - this.engine) * k;
    // Steering eases off at speed so the car stays controllable (speed-sensitive steering).
    const steerTarget = -steer * CAR.steer / (1 + Math.abs(speed) * 0.035);
    this.steering += (steerTarget - this.steering) * k;
    const limit = Math.abs(speed) < CAR.maxSpeed;
    for (let i = 2; i < 4; i++) this.raycast.applyEngineForce(limit ? this.engine : 0, i);
    for (let i = 0; i < 2; i++) this.raycast.setSteeringValue(this.steering, i);
    const brake = braking ? CAR.maxBrake : handbrake ? CAR.maxBrake * 0.6 : 0;
    for (let i = 0; i < 4; i++) this.raycast.setBrake(i >= 2 || braking ? brake : 0, i);
    // Handbrake drift: the rear tyres lose grip while it is held.
    for (let i = 2; i < 4; i++) this.raycast.wheelInfos[i].frictionSlip = CAR.wheel.frictionSlip * this.grip * (handbrake ? 0.45 : 1);
    if (throttle !== 0 || steer !== 0) this.body.wakeUp();
  }

  /** Parked: brakes on, no engine. */
  park() {
    this.engine = 0;
    for (let i = 0; i < 4; i++) { this.raycast.applyEngineForce(0, i); this.raycast.setBrake(CAR.maxBrake * 0.4, i); }
  }

  /** Copy the physics pose to the mesh, spin and steer the wheels. */
  sync(dt: number) {
    const p = this.body.position, q = this.body.quaternion;
    this.mesh.position.set(p.x, p.y - 0.62 - this.sinking * 0.9, p.z);
    this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    const roll = this.forwardSpeed * dt / CAR.wheel.radius;
    for (const child of this.mesh.children) {
      if (child.name === 'front-wheel') { child.rotation.y = this.steering; child.rotation.x -= roll; }
      else if (child.name === 'rear-wheel') child.rotation.x -= roll;
    }
  }

  remove() { this.raycast.removeFromWorld(this.world); }
}
