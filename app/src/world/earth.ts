import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface Place {
  lat: number;
  lng: number;
  locality: string;
  city: string;
  region: string;
  country: string;
  source: 'network' | 'device' | 'search' | 'globe' | 'fallback';
}

export interface Activity {
  id: string;
  kind: string;
  title: string;
  description: string;
  place: string;
  time: string;
  people: number;
  distance: number;
  luma?: { url: string; cover?: string; count: number | null };
  venuePoint?: [number, number];
  x: number;
  z: number;
}


/** The street map's palette (see world/atlas.ts and atlas-hud.css). The globe uses it too. */
const ATLAS = {
  space: '#dcebf8', land: '#c3cc9a', green: '#73a790', dry: '#dfbd99', ice: '#e8edf0',
  water: '#659ec6', deep: '#5086b9', coast: '#e9eee6', border: '#777e8a',
  lights: '#f5bd52', rim: '#e8dcc1', glow: '#d9c7a3', cloud: '#cfcec4',
} as const;

const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
/** Eases in, then keeps full speed to the end (no slow-down where the globe has no detail left). */
const easeInSteady = (t: number) => (t < 0.3 ? (t * t) / 0.6 : t - 0.15) / 0.85;
const tween = (duration: number, update: (value: number) => void, easing: (t: number) => number = ease) => new Promise<void>((resolve) => {
  // Useful for reduced-motion captures and deterministic visual QA.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('instant')) {
    update(1);
    resolve();
    return;
  }
  const started = performance.now();
  const frame = (now: number) => {
    const value = Math.min(1, (now - started) / duration);
    update(easing(value));
    if (value < 1) requestAnimationFrame(frame); else resolve();
  };
  requestAnimationFrame(frame);
});

export class EarthExperience {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 120);
  private renderer: THREE.WebGLRenderer;
  private earthRoot = new THREE.Group();
  private earthSurface?: THREE.Mesh;
  private framing = 1;
  private cloudMesh?: THREE.Mesh;
  private atmosphere?: THREE.Mesh;
  private surfaceMaterial?: THREE.ShaderMaterial;
  private cloudMaterial?: THREE.ShaderMaterial;
  /** 0 = styled globe, 1 = flat street-map colours (used at the handoff). */
  private mapBlend = 0;
  private earthLoaded?: Promise<void>;
  private stars?: THREE.Points;
  exploring = false;
  private landing = false;
  private localMode = false;
  private targetRotation = new THREE.Euler(0.13, -0.42, -0.05, 'YXZ');

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 700 ? 1.5 : 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.frame();
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The globe uses the street map's palette, so colours must not be tone mapped.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.scene.background = new THREE.Color(ATLAS.space);
    this.camera.position.set(0, 0.32, 6.15);
    this.scene.add(this.earthRoot);
    this.addStars();
    this.earthLoaded = this.loadEarth();
    this.animate();
    addEventListener('resize', this.resize);
  }

  enableNavigation(canvas: HTMLCanvasElement, pick: (lat:number, lng:number) => void) {
    const ray = new THREE.Raycaster();
    const hit = (x:number,y:number) => {
      if (!this.exploring || !this.earthSurface) return;
      const box = canvas.getBoundingClientRect();
      this.camera.updateMatrixWorld();
      this.earthRoot.updateMatrixWorld(true);
      ray.setFromCamera(new THREE.Vector2(2*(x-box.left)/box.width-1, 1-2*(y-box.top)/box.height),this.camera);
      return ray.intersectObject(this.earthSurface,false)[0]?.point.normalize();
    };
    let drag: {id:number; x:number; y:number; moved:boolean} | undefined;
    canvas.onpointerdown = e => {
      if (e.button !== 0 || !hit(e.clientX,e.clientY)) return;
      canvas.setPointerCapture(e.pointerId);
      drag = {id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};
    };
    canvas.onpointermove = e => {
      if (!this.exploring || drag?.id !== e.pointerId) return;
      const dx=e.clientX-drag.x, dy=e.clientY-drag.y;
      if (!drag.moved && Math.hypot(dx,dy)<4) return;
      drag.moved = true;
      const speed = (this.camera.position.z-1.6)/innerHeight;
      this.earthRoot.rotateOnWorldAxis(new THREE.Vector3(0,1,0),dx*speed);
      this.earthRoot.rotateOnWorldAxis(new THREE.Vector3(1,0,0),dy*speed);
      drag.x=e.clientX; drag.y=e.clientY;
    };
    const land = (point:THREE.Vector3) => {
      const normal = point.applyQuaternion(this.earthRoot.quaternion.clone().invert());
      this.exploring=false;
      pick(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(normal.y,-1,1))),
        THREE.MathUtils.radToDeg(Math.atan2(normal.x,normal.z)));
    };
    canvas.onpointerup = e => {
      if (drag?.id !== e.pointerId) return;
      const point = hit(e.clientX,e.clientY);
      const tap = !drag.moved; drag=undefined;
      if (tap && point) land(point);
    };
    canvas.onlostpointercapture = () => { drag=undefined; };
    canvas.addEventListener('wheel', e => {
      const before = hit(e.clientX,e.clientY);
      if (!before) return;
      e.preventDefault();
      const delta=e.deltaY*(e.deltaMode===1 ? 16 : e.deltaMode===2 ? innerHeight : 1);
      const z=1.6+(this.camera.position.z-1.6)*Math.exp(THREE.MathUtils.clamp(delta*.002,-1,1));
      if (z<2.0) {land(before); return;}
      this.camera.position.z=THREE.MathUtils.clamp(z,2,9);
      const after=hit(e.clientX,e.clientY);
      if (after) this.earthRoot.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(before,after));
    },{passive:false});
  }

  async ready(progress: (value: number, label: string) => void) {
    progress(0.15, 'Loading orbital imagery');
    await this.earthLoaded;
    progress(0.72, 'Lighting the atmosphere');
    await new Promise((resolve) => setTimeout(resolve, 260));
    progress(1, 'Earth ready');
  }

  private async loadEarth() {
    const loader = new THREE.TextureLoader();
    const [gltf, day, night, specular, clouds, lines] = await Promise.all([
      new GLTFLoader().loadAsync('/models/earth.glb'),
      loader.loadAsync('/textures/earth_atmos_2048.jpg'),
      loader.loadAsync('/textures/earth_lights_2048.png'),
      loader.loadAsync('/textures/earth_specular_2048.jpg'),
      loader.loadAsync('/textures/earth_clouds_1024.png'),
      loader.loadAsync('/textures/atlas_lines_4096.png'),
    ]);
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    day.colorSpace = THREE.SRGBColorSpace;
    [night, specular, clouds, lines].forEach((texture) => { texture.colorSpace = THREE.NoColorSpace; });
    // glTF UVs use a top-left origin, so these maps must not be flipped.
    [day, night, specular, clouds, lines].forEach((texture) => {
      texture.anisotropy = anisotropy; texture.wrapS = THREE.RepeatWrapping; texture.flipY = false; texture.needsUpdate = true;
    });

    const source = gltf.scene.getObjectByName('Earth') as THREE.Mesh;
    const geometry = source.geometry;
    const color = (hex: string) => new THREE.Color(hex);
    const sun = new THREE.Vector3(-2.8, 1.6, 4).normalize();

    // Atlas-styled Earth: the same charcoal land, slate water, cream lines and
    // amber lights as the street map. mapBlend flattens it to the map's exact
    // land and water colours for the handoff.
    this.surfaceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: day }, nightMap: { value: night }, specularMap: { value: specular }, linesMap: { value: lines },
        sunDirection: { value: sun }, opacity: { value: 1 }, mapBlend: { value: 0 }, lineFade: { value: 1 }, lightFade: { value: 1 },
        landColor: { value: color(ATLAS.land) }, greenColor: { value: color(ATLAS.green) }, dryColor: { value: color(ATLAS.dry) },
        iceColor: { value: color(ATLAS.ice) }, waterColor: { value: color(ATLAS.water) }, deepColor: { value: color(ATLAS.deep) },
        coastColor: { value: color(ATLAS.coast) }, borderColor: { value: color(ATLAS.border) },
        lightColor: { value: color(ATLAS.lights) }, rimColor: { value: color(ATLAS.rim) },
      },
      vertexShader: `
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main(){
          vUv=uv; vec4 world=modelMatrix*vec4(position,1.0);
          vNormal=normalize(mat3(modelMatrix)*normal); vView=normalize(cameraPosition-world.xyz);
          gl_Position=projectionMatrix*viewMatrix*world;
        }`,
      fragmentShader: `
        uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D specularMap; uniform sampler2D linesMap;
        uniform vec3 sunDirection; uniform float opacity; uniform float mapBlend; uniform float lineFade; uniform float lightFade;
        uniform vec3 landColor; uniform vec3 greenColor; uniform vec3 dryColor; uniform vec3 iceColor;
        uniform vec3 waterColor; uniform vec3 deepColor; uniform vec3 coastColor; uniform vec3 borderColor;
        uniform vec3 lightColor; uniform vec3 rimColor;
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main(){
          float style=1.0-mapBlend;
          vec3 day=texture2D(dayMap,vUv).rgb;
          float lum=dot(day,vec3(0.2126,0.7152,0.0722));
          float water=smoothstep(0.3,0.7,texture2D(specularMap,vUv).r);

          // Land: charcoal, with vegetation, deserts and ice hinted from the satellite image.
          float green=clamp((day.g-max(day.r,day.b))*9.0,0.0,1.0);
          float dry=clamp((day.r-day.b)*4.0-green,0.0,1.0);
          float sat=max(day.r,max(day.g,day.b))-min(day.r,min(day.g,day.b));
          float ice=smoothstep(0.45,0.65,lum)*(1.0-smoothstep(0.06,0.14,sat))*(1.0-green);
          vec3 land=mix(landColor,greenColor,green*0.85*style);
          land=mix(land,dryColor,dry*0.55*style);
          land=mix(land,iceColor,ice*0.8*style);
          land*=mix(1.0,0.82+lum*0.9,style);           // soft relief
          vec3 sea=mix(waterColor,mix(deepColor,waterColor,smoothstep(0.0,0.05,lum)),style);
          vec3 base=mix(land,sea,water);

          // Cream coastlines and quiet borders, like the map's labels and roads.
          vec2 ink=texture2D(linesMap,vUv).rg;
          base=mix(base,coastColor,ink.r*0.6*style*lineFade);
          base=mix(base,borderColor,ink.g*0.4*style*lineFade);

          // Faint graticule every 15 degrees: the atlas grid.
          vec2 deg=vec2(vUv.x*360.0,vUv.y*180.0);
          vec2 cell=abs(fract(deg/15.0+0.5)-0.5)*15.0/max(fwidth(deg),vec2(1e-4));
          float grid=1.0-smoothstep(0.0,1.1,min(cell.x,cell.y));
          base=mix(base,coastColor,grid*0.07*style*lineFade);

          // Gentle day and night, never pitch black, so land stays readable.
          vec3 n=normalize(vNormal); float light=dot(n,normalize(sunDirection));
          float daylight=smoothstep(-0.3,0.35,light);
          vec3 color=base*mix(1.0,mix(0.45,1.05,daylight),style);

          // Cities as warm amber points, brightest on the night side.
          float city=smoothstep(0.1,0.65,dot(texture2D(nightMap,vUv).rgb,vec3(0.3333)));
          color+=lightColor*city*mix(0.18,0.95,1.0-daylight)*style*lightFade;

          float rim=pow(1.0-max(dot(n,normalize(vView)),0.0),3.0);
          color+=rimColor*rim*0.28*daylight*style;
          gl_FragColor=vec4(color,opacity);
          #include <colorspace_fragment>
        }`,
      transparent: true,
    });
    this.earthSurface = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.earthRoot.add(this.earthSurface);

    // Thin, warm-grey cloud wisps that fade out as the map takes over.
    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: { cloudMap: { value: clouds }, opacity: { value: 1 }, sunDirection: { value: sun }, cloudColor: { value: color(ATLAS.cloud) } },
      vertexShader: `varying vec2 vUv; varying vec3 vNormal;
        void main(){ vUv=uv; vNormal=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D cloudMap; uniform float opacity; uniform vec3 sunDirection; uniform vec3 cloudColor;
        varying vec2 vUv; varying vec3 vNormal;
        void main(){
          vec4 c=texture2D(cloudMap,vUv);
          float a=dot(c.rgb,vec3(0.3333))*c.a;
          float daylight=smoothstep(-0.3,0.35,dot(normalize(vNormal),normalize(sunDirection)));
          gl_FragColor=vec4(cloudColor*mix(0.45,1.0,daylight),a*0.26*opacity);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(geometry, this.cloudMaterial);
    this.cloudMesh.scale.setScalar(1.007);
    this.earthRoot.add(this.cloudMesh);

    // A restrained, warm atmosphere line instead of a neon ring.
    const atmosphereMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { opacity: { value: 1 }, glow: { value: color(ATLAS.glow) } },
      vertexShader: `varying vec3 n; varying vec3 eye; void main(){vec4 w=modelMatrix*vec4(position,1.0);n=normalize(mat3(modelMatrix)*normal);eye=normalize(cameraPosition-w.xyz);gl_Position=projectionMatrix*viewMatrix*w;}`,
      fragmentShader: `uniform float opacity; uniform vec3 glow; varying vec3 n; varying vec3 eye;
        void main(){float i=pow(clamp(1.0+dot(normalize(n),normalize(eye)),0.0,1.0),7.0);gl_FragColor=vec4(glow,i*0.55*opacity);
        #include <colorspace_fragment>
        }`,
    });
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.627, 128, 96), atmosphereMaterial);
    this.earthRoot.add(this.atmosphere);
    this.earthRoot.rotation.copy(this.targetRotation);
  }

  private addStars() {
    const count = innerWidth < 700 ? 1100 : 2200;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const radius = 18 + Math.random() * 50;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions.set([radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)], i * 3);
      const warmth = 0.55 + Math.random() * 0.4;
      colors.set([warmth, warmth * 0.94, warmth * 0.82], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.stars = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.018, vertexColors: true, transparent: true, opacity: 0.5, sizeAttenuation: true }));
    this.scene.add(this.stars);
  }

  async flyTo(place: Place, progress: (value: number, label: string) => void) {
    await this.earthLoaded;
    this.exploring = false;
    this.landing = true;
    this.earthRoot.visible = true;
    if (this.stars) this.stars.visible = true;
    this.earthRoot.scale.setScalar(1);
    const initialZ = this.localMode ? 6.15 : Math.max(2,this.camera.position.z);
    this.localMode = false;
    this.camera.position.set(0, 0, initialZ);
    this.framing = 1;
    this.frame();
    this.setEarthOpacity(1);
    this.setMapBlend(0);
    const startRotation = this.earthRoot.quaternion.clone();
    // The Blender export puts Greenwich on +Z, east on +X, north on +Y.
    // Rotate the destination onto the optical axis along the shortest arc
    // first. Correct the roll around that axis before beginning the descent.
    const lat = THREE.MathUtils.degToRad(place.lat), lon = THREE.MathUtils.degToRad(place.lng);
    const normal = new THREE.Vector3(Math.cos(lat)*Math.sin(lon), Math.sin(lat), Math.cos(lat)*Math.cos(lon));
    const north = new THREE.Vector3(-Math.sin(lat)*Math.sin(lon), Math.cos(lat), -Math.sin(lat)*Math.cos(lon));
    const axis = new THREE.Vector3(0, 0, 1);
    const turn = new THREE.Quaternion().setFromUnitVectors(normal.applyQuaternion(startRotation), axis);
    const aligned = turn.clone().multiply(startRotation);
    north.applyQuaternion(aligned);
    const roll = Math.atan2(north.x, north.y);
    const rotation = new THREE.Quaternion();
    this.camera.position.y = 0;
    await tween(1800, (t) => {
      rotation.identity().slerp(turn, t);
      this.earthRoot.quaternion.copy(rotation).multiply(startRotation);
      this.framing = 1 - t;
      this.frame();
      progress(0.1 + t * 0.35, 'Aligning with ' + place.locality);
    });
    const alignedZ = Math.min(initialZ,5.2);
    await tween(650, (t) => {
      this.earthRoot.quaternion.setFromAxisAngle(axis, roll * t).multiply(aligned);
      this.camera.position.z = THREE.MathUtils.lerp(initialZ, alignedZ, t);
    });
    await tween(1650, (t) => {
      // Exponential altitude makes the approach track a constant geographic
      // center as the view narrows from a hemisphere to a regional map. The
      // t^1.35 curve lingers where the globe has detail and moves quickly
      // through the last, blurry zoom levels to the street map.
      this.camera.position.z = 1.6 + (alignedZ-1.6) * Math.pow(0.06 / (alignedZ-1.6), Math.pow(t, 1.35));
      // In the last stretch the globe settles into the street map's flat palette,
      // so the map that fades in on top continues the same picture.
      // Flatten most of the way only: the map then crossfades over a lightly textured ground.
      this.setMapBlend(0.7 * THREE.MathUtils.smoothstep(t, 0.6, 1.0));
      progress(0.45 + t * 0.55, 'Approaching ' + place.locality);
    }, easeInSteady);
    // Render the terminal pose even when reduced motion skips animation frames.
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    this.localMode = true;
    this.landing = false;
  }

  async returnToGlobe() {
    // The reverse of the landing: start where the street map is, in its flat
    // palette, and pull back out to the styled globe.
    this.localMode = false;
    this.landing = true;
    this.earthRoot.visible = true;
    if (this.stars) this.stars.visible = true;
    this.setEarthOpacity(1);
    this.setMapBlend(1);
    this.camera.position.set(0, 0, 1.66);
    this.framing = 0;
    this.frame();
    await tween(1900, (t) => {
      this.camera.position.z = 1.6 + 0.06 * Math.pow((6.15 - 1.6) / 0.06, t);
      this.setMapBlend(1 - THREE.MathUtils.smoothstep(t, 0.03, 0.45));
      this.framing = t;
      this.frame();
    });
    this.landing = false;
  }

  private setEarthOpacity(value: number) {
    if (this.surfaceMaterial) this.surfaceMaterial.uniforms.opacity.value = value;
    this.applyBlend(value);
  }

  /** Move the look between the styled globe (0) and the flat street map (1). */
  private setMapBlend(value: number) {
    this.mapBlend = THREE.MathUtils.clamp(value, 0, 1);
    if (this.surfaceMaterial) this.surfaceMaterial.uniforms.mapBlend.value = this.mapBlend;
    this.applyBlend(this.surfaceMaterial?.uniforms.opacity.value ?? 1);
  }

  private applyBlend(opacity: number) {
    const style = 1 - this.mapBlend;
    if (this.cloudMaterial) this.cloudMaterial.uniforms.opacity.value = opacity * style * style;
    if (this.atmosphere) (this.atmosphere.material as THREE.ShaderMaterial).uniforms.opacity.value = opacity * style;
    if (this.stars) (this.stars.material as THREE.PointsMaterial).opacity = 0.5 * style;
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    if (this.localMode) return;
    if (this.cloudMesh) this.cloudMesh.rotation.y += 0.000008;
    if (this.surfaceMaterial) {
      // Lines and city lights are a few texels wide; fade them before they magnify into blur.
      const altitude = this.camera.position.z - 1.6;
      this.surfaceMaterial.uniforms.lineFade.value = THREE.MathUtils.smoothstep(altitude, 0.25, 1.4);
      this.surfaceMaterial.uniforms.lightFade.value = THREE.MathUtils.smoothstep(altitude, 0.35, 1.2);
    }
    if (!this.exploring && !this.landing && !this.localMode) this.earthRoot.rotation.y += 0.00018;
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  };

  /** Shift the projection so the subject sits in the space the panels leave free. */
  private frame() {
    const w = innerWidth, h = innerHeight;
    const shiftX = w > 1080 ? 182 : w > 720 ? 165 : 0;
    const shiftY = w > 720 ? 0 : Math.round(h * 0.13);
    this.camera.setViewOffset(w, h, -shiftX * this.framing, shiftY * this.framing, w, h);
  }

  private resize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.frame();
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 700 ? 1.5 : 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
  };
}
