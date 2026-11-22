import type { GeoJSONSource, Map as StreetMap } from 'maplibre-gl';
import type { Feature, Polygon, Position } from 'geojson';

const sourceId = 'roam-scenery';
const roadLayers = ['road-minor', 'road-mid', 'road-major'];
const carColors = ['#d46b59', '#edbb67', '#82abb9', '#c8c6ba', '#8994b7'];
const greens = ['#63885c', '#769961', '#557e62'];
const metersLat = 111320;
function noise(x: number, y: number) {
  let n = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  n = Math.imul(n ^ n >>> 16, 0x45d9f3b);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}

// Each cuboid uses a footprint in meters, rotated to the street's direction.
function box(parts: Feature<Polygon>[], at: Position, angle: number, length: number, width: number,
    base: number, height: number, color: string, shift = 0) {
  const lonScale = metersLat * Math.cos(at[1] * Math.PI / 180);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ring = [[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]].map(([x,y]) => {
    const along = x * length / 2 + shift, across = y * width / 2;
    return [at[0] + (along*cos-across*sin)/lonScale, at[1] + (along*sin+across*cos)/metersLat];
  });
  parts.push({type:'Feature', properties:{base,height,color}, geometry:{type:'Polygon',coordinates:[ring]}});
}

// The SkyPark spans the three hotel towers. Keep the deck attached to the
// same geographic coordinates as the underlying tower footprints.
function addSkyPark(parts: Feature<Polygon>[], center: {lng:number;lat:number}) {
  const at = [103.86074,1.2838];
  if (Math.abs(center.lng-at[0])>.008 || Math.abs(center.lat-at[1])>.008) return;
  const axis = 62*Math.PI/180;
  box(parts,at,axis,290,34,188,194,'#cbb7a3');
  box(parts,at,axis,322,29,194,198,'#e0ceb4');
  box(parts,at,axis,280,22,198,199,'#809873');
  box(parts,at,axis,144,10,199,199.6,'#68c7ce',-32);
}

function addSportsPresets(map: StreetMap, parts: Feature<Polygon>[]) {
  const seen = new Set<string>();
  const venues = map.querySourceFeatures('omt',{sourceLayer:'poi',filter:['any',
    ['in',['get','subclass'],['literal',['stadium','swimming_pool']]],
    ['in',['get','class'],['literal',['stadium','swimming_pool']]]]});
  for (const venue of venues) {
    if (venue.geometry.type !== 'Point') continue;
    const at = venue.geometry.coordinates;
    if (!map.getBounds().contains([at[0],at[1]])) continue;
    const key = at.map(v => v.toFixed(4)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if ([venue.properties.class,venue.properties.subclass].includes('stadium')) {
      box(parts,at,0,90,52,0,.5,'#588355');
      for (const side of [-1,1]) {
        box(parts,[at[0],at[1]+side*31/metersLat],0,100,9,0,7,'#af9d87');
        box(parts,[at[0],at[1]+side*38/metersLat],0,105,7,0,11,'#d7c7ac');
      }
    } else {
      box(parts,at,0,26,13,0,.4,'#dfd8c1');
      box(parts,at,0,24,11,.4,.55,'#69bccc');
    }
  }
}

export class RoamScenery {
  private dirty = false;
  private active = false;
  constructor(private map: StreetMap) {
    map.on('moveend', () => { this.dirty = true; });
    map.on('sourcedata', event => { if (event.sourceId === 'omt' || event.sourceId === 'overture') this.dirty = true; });
    map.on('idle', () => {
      if (!this.active || !this.dirty) return;
      this.dirty = false;
      this.populate();
    });
  }

  show(active: boolean) {
    this.active = active;
    this.dirty = active;
    if (!this.map.getSource(sourceId)) {
      if (!active) return;
      this.map.addSource(sourceId, {type:'geojson',data:{type:'FeatureCollection',features:[]},maxzoom:20});
      this.map.addLayer({id:sourceId,type:'fill-extrusion',source:sourceId,minzoom:16,
        paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-base':['get','base'],
          'fill-extrusion-height':['get','height']}}, 'label-road');
    }
    this.map.setLayoutProperty(sourceId, 'visibility', active ? 'visible' : 'none');
  }

  private populate() {
    const map = this.map, center = map.getCenter();
    if (map.getZoom() < 16) return;
    const parts: Feature<Polygon>[] = [];
    // Anchor a jittered lattice in geographic coordinates so trees stay put as the camera moves.
    const dy = 23 / metersLat;
    const dx = dy / Math.cos(Math.round(center.lat) * Math.PI / 180);
    const cx = Math.round(center.lng/dx), cy = Math.round(center.lat/dy);
    const mask = ['park','green','blocks','water','waterway','rail',...roadLayers,'road-motorway'];
    const screen = map.getContainer();
    for (let x = cx-12; x <= cx+12; x++) for (let y = cy-12; y <= cy+12; y++) {
      const value = noise(x,y);
      const at: [number,number] = [(x+value*.7)*dx,(y+noise(y,x)*.7)*dy];
      const point = map.project(at);
      if (point.x < -15 || point.y < -15 || point.x > screen.clientWidth+15 || point.y > screen.clientHeight+15) continue;
      const hits = map.queryRenderedFeatures(point,{layers:mask});
      if (!hits.length || hits.some(hit => !['park','green'].includes(hit.layer.id))) continue;
      const h = 5+value*4;
      const crown = greens[Math.floor(value*greens.length)];
      box(parts,at,0,1.2,1.2,0,h*.55,'#856951');
      box(parts,at,0,h*.70,h*.66,h*.40,h*.79,crown);
      box(parts,at,0,h*.46,h*.43,h*.79,h,'#94ad72');
    }
    addSportsPresets(map,parts);
    addSkyPark(parts,center);
    const used = new Set<string>();
    for (const road of map.queryRenderedFeatures(undefined,{layers:roadLayers})) {
      const g = road.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) for (let i=1; i<line.length; i++) {
        const a=line[i-1], b=line[i];
        const at = [(a[0]+b[0])/2,(a[1]+b[1])/2];
        const scale = metersLat*Math.cos(at[1]*Math.PI/180);
        if (Math.abs(at[0]-center.lng)*scale>300 || Math.abs(at[1]-center.lat)*metersLat>300) continue;
        const east=(b[0]-a[0])*scale, north=(b[1]-a[1])*metersLat;
        if (Math.hypot(east,north)<12) continue;
        const x=Math.round(at[0]*1e5), y=Math.round(at[1]*1e5), value=noise(x,y);
        const key=x+','+y;
        if (value>.25 || used.has(key) || used.size>=100) continue;
        used.add(key);
        const angle=Math.atan2(north,east);
        const color=carColors[Math.floor(value*4*carColors.length)%carColors.length];
        box(parts,at,angle,4.9,2.1,0,.42,'#32353c');
        box(parts,at,angle,5.1,2.3,.42,1.1,color);
        box(parts,at,angle,2.8,2,1.1,1.65,'#536b77',-.15);
        box(parts,at,angle,1.6,1.92,1.65,1.78,color,-.25);
      }
    }
    (map.getSource(sourceId) as GeoJSONSource).setData({type:'FeatureCollection',features:parts});
  }
}
