import * as THREE from 'three';
import type { Frame, XZ } from './data';
import { Walker, type HumanAsset } from './human';

const TALK_RANGE = 60;
interface Peer { id: string; name: string; lat: number; lng: number }
interface Avatar { name: string; x: number; z: number; walker?: Walker; label: HTMLButtonElement }

export class RoamPlayers {
  readonly avatars = new Map<string, Avatar>();
  private readonly session = crypto.randomUUID();
  private timer = 0;
  private stopped = false;
  private last?: {lat:number; lng:number};
  private nearest?: string;
  private lastReply = 0;
  private scratch = new THREE.Vector3();
  private button: HTMLButtonElement;
  private labels: HTMLElement;

  constructor(root: HTMLElement, private scene: THREE.Scene, private frame: Frame,
    private asset: HumanAsset | null, private position: () => XZ,
    private user: () => {name:string; canCall:boolean}, private call: (id:string, name:string) => void) {
    this.button = root.querySelector('.roam-peer-call')!;
    this.labels = root.querySelector('.roam-labels')!;
    this.button.onclick = () => { if (this.nearest) this.invite(this.nearest); };
    window.addEventListener('pagehide', this.leave);
    void this.poll();
  }

  private invite(id: string) {
    const avatar = this.avatars.get(id), [x,z] = this.position();
    if (avatar && this.user().canCall && Math.hypot(x-avatar.x,z-avatar.z) <= TALK_RANGE) this.call(id,avatar.name);
  }
  private leave = () => {
    if (this.last) {
      const body = new Blob([JSON.stringify({...this.last,session:this.session,leave:true})],{type:'application/json'});
      navigator.sendBeacon('/api/nexconn/roam',body);
    }
  };
  private async poll() {
    const user = this.user();
    if (user.canCall && !document.hidden) {
      const [lng,lat] = this.frame.toLngLat(...this.position());
      const point = {lng: Math.round((((lng + 540) % 360)-180)*1e5)/1e5, lat: Math.round(lat*1e5)/1e5};
      this.last = point;
      try {
        const response = await fetch('/api/nexconn/roam', {method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({...point,session:this.session,name:user.name}), signal:AbortSignal.timeout(6000)});
        if (!response.ok) throw Error();
        const {players} = await response.json() as {players:Peer[]};
        if (this.stopped) { this.leave(); return; }
        this.lastReply = performance.now();
        this.sync(players);
      } catch { /* Expire old sightings when connectivity is lost. */ }
    }
    if (!this.stopped) this.timer = window.setTimeout(() => void this.poll(), 1500);
  }

  private sync(peers: Peer[]) {
    const ids = new Set(peers.map(p => p.id));
    for (const [id,a] of this.avatars) if (!ids.has(id)) {
      a.label.remove();
      if (a.walker) { this.scene.remove(a.walker.object); a.walker.body.dispose(); }
      this.avatars.delete(id);
    }
    for (const p of peers) {
      const lng = this.frame.lng0 + ((p.lng-this.frame.lng0+540)%360-180);
      const [x,z] = this.frame.toLocal(lng,p.lat);
      let a = this.avatars.get(p.id);
      if (!a) {
        const label = document.createElement('button');
        label.className = 'roam-player-label'; label.type = 'button';
        label.onclick = () => this.invite(p.id); this.labels.append(label);
        const walker = this.asset ? new Walker(this.asset) : undefined;
        if (walker) { walker.place(x,z,0); walker.sync(); this.scene.add(walker.object); }
        a = {name:p.name, x,z,label,walker};
        this.avatars.set(p.id,a);
      }
      a.name = p.name; a.x = x; a.z = z;
      a.label.textContent = p.name;
    }
  }

  update(camera: THREE.Camera, dt:number) {
    if (this.avatars.size && performance.now()-this.lastReply > 12000) this.sync([]);
    const [x,z] = this.position();
    let closest = TALK_RANGE, nearest: string | undefined;
    for (const [id,a] of this.avatars) {
      const d = Math.hypot(a.x-x,a.z-z);
      if (d <= closest) { closest=d; nearest=id; }
      if (a.walker) {
        const w=a.walker, dx=a.x-w.x, dz=a.z-w.z, k=1-Math.exp(-dt*4);
        if (Math.hypot(dx,dz) > .3) w.heading = Math.atan2(dx,-dz);
        w.x+=dx*k; w.z+=dz*k; w.sync(); w.body.blend(Math.min(4,Math.hypot(dx,dz)*4),dt,-1);
      }
      const v=this.scratch.set(a.walker?.x ?? a.x,3,a.walker?.z ?? a.z).project(camera);
      a.label.hidden = v.z < -1 || v.z > 1 || Math.abs(v.x)>1 || Math.abs(v.y)>1;
      a.label.disabled = d > TALK_RANGE;
      if (!a.label.hidden) a.label.style.transform = `translate(${(v.x+1)*innerWidth/2}px,${(1-v.y)*innerHeight/2}px) translate(-50%,-100%)`;
    }
    this.nearest = nearest;
    this.button.hidden = !nearest;
    if (nearest) {
      const label='Call ' + this.avatars.get(nearest)!.name;
      if(this.button.textContent!==label) this.button.textContent=label;
    }
  }
  dispose() {
    this.stopped=true; clearTimeout(this.timer);
    window.removeEventListener('pagehide',this.leave);
    this.leave(); this.sync([]);
  }
}
