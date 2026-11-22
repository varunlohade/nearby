// Adaptive quality for Free Roam, so it runs on most laptops and on phones.
// A tier is picked once from the device (pointer, memory, cores, GPU name), and
// the render resolution then adapts to the measured frame time.

import type * as THREE from 'three';

export type Tier = 'high' | 'medium' | 'low';
export interface Quality {
  tier: Tier; reason: string;
  dprCap: number; viewRadius: number; buildBudgetMs: number; chunkBuildings: number; physicsRadius: number;
  traffic: number; pedestrians: number; parked: number; props: boolean;
  fogFar: number; windows: boolean; antialias: boolean; labelsFar: number; minimapEvery: number;
}

// The fog ends inside the view radius so chunk edges are never seen.
const PRESETS: Record<Tier, Omit<Quality, 'tier' | 'reason'>> = {
  high: { dprCap: 1.5, viewRadius: 640, buildBudgetMs: 4, chunkBuildings: 900, physicsRadius: 150, traffic: 24, pedestrians: 18, parked: 8, props: true,
    fogFar: 560, windows: true, antialias: true, labelsFar: 520, minimapEvery: 1 },
  medium: { dprCap: 1.25, viewRadius: 480, buildBudgetMs: 3, chunkBuildings: 600, physicsRadius: 120, traffic: 14, pedestrians: 12, parked: 5, props: true,
    fogFar: 430, windows: true, antialias: false, labelsFar: 420, minimapEvery: 2 },
  low: { dprCap: 1.0, viewRadius: 340, buildBudgetMs: 2, chunkBuildings: 350, physicsRadius: 100, traffic: 8, pedestrians: 6, parked: 3, props: false,
    fogFar: 310, windows: false, antialias: false, labelsFar: 300, minimapEvery: 3 },
};

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

export function detectQuality(): Quality {
  const forced = new URLSearchParams(location.search).get('roamtier') as Tier | null;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 8, cores = nav.hardwareConcurrency ?? 8;
  const phone = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
  const gpu = gpuName();
  const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
  const mobileGpu = /mali|adreno|powervr|apple gpu|videocore/i.test(gpu);
  const strong = /apple m\d|nvidia|geforce|rtx|radeon( rx| pro)|arc a/i.test(gpu);
  let tier: Tier, reason: string;
  if (forced && forced in PRESETS) { tier = forced; reason = 'forced by ?roamtier'; }
  else if (software || memory <= 2 || cores <= 2) { tier = 'low'; reason = software ? 'software renderer' : 'little memory or few cores'; }
  else if (phone || mobileGpu) { tier = memory >= 6 && cores >= 8 && !/mali|powervr/i.test(gpu) ? 'medium' : 'low'; reason = 'phone or tablet'; }
  else if (strong && memory >= 8) { tier = 'high'; reason = 'capable laptop or desktop GPU'; }
  else { tier = memory >= 8 && cores >= 8 ? 'high' : 'medium'; reason = 'laptop with integrated or unknown GPU'; }
  return { tier, reason: `${reason}${gpu ? ` · ${gpu.slice(0, 60)}` : ''}`, ...PRESETS[tier] };
}

/**
 * Dynamic resolution: drop the pixel ratio when frames stay slower than ~20 ms,
 * and raise it again (up to the tier's cap) when there is headroom.
 */
export class DynamicResolution {
  private acc = 0; private frames = 0; private slow = 0; private fast = 0;
  ratio: number;
  constructor(private renderer: THREE.WebGLRenderer, private cap: number, private floor = 0.55) {
    this.ratio = Math.min(devicePixelRatio, cap);
    renderer.setPixelRatio(this.ratio);
  }
  update(dt: number) {
    this.acc += dt; this.frames++;
    if (this.acc < 0.5) return;
    const frameMs = (this.acc / this.frames) * 1000;
    this.acc = 0; this.frames = 0;
    if (frameMs > 20) { this.slow++; this.fast = 0; } else if (frameMs < 13) { this.fast++; this.slow = 0; } else { this.slow = this.fast = 0; }
    let next = this.ratio;
    if (this.slow >= 2) { next = Math.max(this.floor, this.ratio - 0.15); this.slow = 0; }
    if (this.fast >= 6) { next = Math.min(Math.min(devicePixelRatio, this.cap), this.ratio + 0.1); this.fast = 0; }
    if (Math.abs(next - this.ratio) > 0.01) {
      this.ratio = next;
      this.renderer.setPixelRatio(next); // also resizes the drawing buffer
    }
  }
}
