import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { BuildingTiles } from './buildings';
import { RoamScenery } from './scenery';
import 'maplibre-gl/dist/maplibre-gl.css';
import streetStyle from '../map/style.json';
import type { Activity, Place } from './earth';

const style = structuredClone(streetStyle) as unknown as StyleSpecification;
const ink: Record<string, string> = {
  land: '#e8e3f0', park: '#a8ccbb', green: '#bed8c8', water: '#a4c0df', waterway: '#8dabd1',
  aeroway: '#cbc4d8', 'road-minor': '#fcf9ff', 'road-mid': '#fffdf7',
  'road-major': '#fffaf0', 'road-motorway': '#ffeccc', rail: '#9b8fac',
};
const buildings = style.layers.find(layer => layer.type === 'fill-extrusion')!;
buildings.layout = { visibility: 'none' };
Object.assign(buildings.paint!, {
  'fill-extrusion-color': ['to-color', ['coalesce', ['get','building:colour'], ['get','colour'], ''],
    ['match', ['coalesce', ['get','subclass'], ['get','class'], ''],
      ['commercial','retail'], '#d89977', ['industrial','warehouse'], '#8a9ca7',
      ['school','university','college'], '#deb684', ['hospital','clinic'], '#c59caa',
      ['apartments','residential','house'], '#c5ac91',
      ['step', ['coalesce', ['get','render_height'], 8], '#ad9389', 8, '#cdb994', 16, '#bba5af', 32, '#98aeb4', 65, '#8897af']]],
  'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8]
});
for (const layer of style.layers) {
  if (layer.type === 'symbol') {
    layer.paint = { ...layer.paint, 'text-color': '#3c3651', 'text-halo-color': '#f6f2fa', 'text-halo-width': 1.5 };
    if (layer.id === 'label-place') layer.layout = { ...layer.layout, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14 };
  } else if (ink[layer.id]) {
    Object.assign(layer.paint!, { [layer.type + '-color']: ink[layer.id] });
  }
}
// A narrow outline keeps broad, pale roads readable through parks and city blocks.
for (const id of ['road-mid','road-major','road-motorway']) {
  const index = style.layers.findIndex(layer => layer.id === id);
  const line = style.layers[index];
  if (line?.type !== 'line') continue;
  const casing = structuredClone(line);
  casing.id += '-outline';
  casing.paint = {...casing.paint, 'line-color':'#b2a5bd',
    'line-width':['interpolate',['linear'],['zoom'],10,1,14,id==='road-mid' ? 3 : 4.5,18,id==='road-mid' ? 16 : 24]};
  style.layers.splice(index,0,casing);
}
style.layers.splice(1, 0, { id: 'blocks', type: 'fill', source: 'omt', 'source-layer': 'building',
  paint: { 'fill-color': '#cfc6dd', 'fill-opacity': 0.85 } });

export class StreetAtlas {
  private map: maplibregl.Map;
  private buildingTiles: BuildingTiles;
  private scenery: RoamScenery;
  private nativeRatio = 1;
  private styleReady = false;
  private pins: maplibregl.Marker[] = [];
  private positions = new Map<string, [number, number]>();
  private bounds = new maplibregl.LngLatBounds();
  private origin: [number, number] = [0, 0];
  private waypoint?: maplibregl.Marker;
  private picking = false;
  private preview?: maplibregl.Popup;
  private selected?: { id: string; card: HTMLElement };

  private get instant() {
    return document.documentElement.classList.contains('instant') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  constructor(container: HTMLElement, dismiss: () => void) {
    this.map = new maplibregl.Map({ container, style, center: [0, 0], zoom: 1, maxPitch: 68,
      dragRotate: false, touchPitch: false, attributionControl: false, maxZoom: 18 });
    this.map.once('style.load', () => { this.styleReady = true; this.showRoamLayers(Boolean(this.overview)); });
    this.buildingTiles = new BuildingTiles(this.map);
    this.scenery = new RoamScenery(this.map);
    this.map.on('moveend', () => this.updateSearchButton());
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.on('click', event => {
      if (this.picking) this.placeWaypoint(event.lngLat);
      else if (!(event.originalEvent.target as Element).closest('.blip, .maplibregl-popup')) dismiss();
    });
    document.querySelector<HTMLButtonElement>('#pin-mode')!.onclick = () => {
      if (this.picking) { this.clearWaypoint(); return; }
      this.picking = true;
      document.body.classList.add('picking');
      document.querySelector('#pin-mode')!.setAttribute('aria-pressed', 'true');
      this.waypointControls('Tap a spot on the map', true);
    };
    document.querySelector<HTMLButtonElement>('#pin-center')!.onclick = () => this.placeWaypoint(this.map.getCenter());
    document.querySelector<HTMLButtonElement>('#pin-clear')!.onclick = () => this.clearWaypoint();
    this.map.on('resize', () => {
      if (this.selected) this.focus(this.selected.id, this.selected.card, false);
    });
    this.map.on('error', () => {
      if (!this.map.areTilesLoaded()) container.classList.add('tiles-pending');
    });
    this.map.on('idle', () => container.classList.toggle('tiles-pending', !this.map.queryRenderedFeatures(undefined, {layers:['road-mid','water','green','road-major','blocks']}).length));
  }

  get center() { return this.map.getCenter().wrap(); }

  updateSearchButton() {
    document.querySelector<HTMLButtonElement>('#search-map-area')!.hidden =
      this.center.distanceTo(maplibregl.LngLat.convert(this.origin)) < 700;
  }

  get venuePoint(): [number, number] | undefined {
    return this.waypoint?.getLngLat().wrap().toArray();
  }

  show(place: Place, activities: Activity[], makePin: (event: Activity) => HTMLElement, landing = true) {
    if (landing) {
      this.clearWaypoint();
      this.buildingTiles.prepare(place.lng,place.lat);
    }
    this.pins.forEach(pin => pin.remove());
    this.positions.clear();
    this.origin = [place.lng, place.lat];
    this.bounds = new maplibregl.LngLatBounds(this.origin, this.origin);
    this.updateSearchButton();
    const player = document.createElement('div');
    player.className = 'player-position';
    player.setAttribute('aria-label', 'Your selected area');
    player.innerHTML = '<i></i><span>Area center</span>';
    this.pins = [new maplibregl.Marker({element: player}).setLngLat(this.origin).addTo(this.map)];
    for (const event of activities) {
      const at: [number, number] = event.venuePoint ?? [place.lng + event.x / (111.32 * Math.cos(place.lat * Math.PI / 180)), place.lat - event.z / 111.32];
      this.positions.set(event.id, at);
      this.bounds.extend(at);
      this.pins.push(new maplibregl.Marker({element: makePin(event), anchor:'bottom'}).setLngLat(at).addTo(this.map));
    }
    if (!landing) return;
    // Match the final orbital image scale at this latitude in Web Mercator.
    const latitudeScale = Math.max(0.087, Math.cos(place.lat * Math.PI / 180));
    const visibleRadians = 2 * 0.06 * Math.tan(19 * Math.PI / 180) / 1.6;
    const zoom = Math.log2(innerHeight * Math.PI * 2 * latitudeScale / (512 * visibleRadians));
    this.map.jumpTo({center: this.origin, zoom, bearing: 0, pitch: 0});
  }

  async land() {
    const duration = this.instant ? 0 : 1500;
    const finished = duration ? this.map.once('moveend') : undefined;
    this.map.easeTo({center:this.origin, zoom:14, bearing:0, pitch:0, duration});
    if (finished && this.map.isMoving()) await finished;
  }

  private overview?: maplibregl.CameraOptions;

  toggleRoam(active: boolean) {
    if (active === Boolean(this.overview)) return;
    this.map.stop();
    if (active) {
      this.overview = {center: this.center, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: 0};
      this.nativeRatio = this.map.getPixelRatio();
      this.map.setPixelRatio(0.75);
      this.showRoamLayers(true);
      this.clearWaypoint();
      this.map.easeTo({center: this.origin, zoom: 17.4, bearing: -28, pitch: 62, duration: this.instant ? 0 : 850});
    } else {
      this.showRoamLayers(false);
      this.map.setPixelRatio(this.nativeRatio);
      this.map.jumpTo(this.overview!);
      this.overview = undefined;
    }
  }

  private showRoamLayers(active: boolean) {
    if (!this.styleReady) return;
    this.map.setLayoutProperty('buildings-3d','visibility',active?'visible':'none');
    this.buildingTiles.show(active);
    this.scenery.show(active);
  }

  step(direction: string) {
    if (!this.overview) return;
    if (direction === 'left' || direction === 'right') {
      this.map.rotateTo(this.map.getBearing() + (direction === 'left' ? -12 : 12), {duration: this.instant ? 0 : 120});
    } else {
      this.map.panBy([0, direction === 'forward' ? -60 : 60], {duration: this.instant ? 0 : 120});
    }
  }

  private padding() {
    const small = innerWidth <= 720;
    return small ? {top: 155, bottom: 208, left: 38, right: 72} :
      {top: 110, bottom: 130, left: 340, right: 100};
  }

  home(animate = true, duration = 450) {
    const padding = this.padding();
    if (innerHeight < padding.top + padding.bottom + 60) { padding.top = 45; padding.bottom = 45; }
    this.map.fitBounds(this.bounds, {padding, maxZoom: 15, duration: animate && !this.instant ? duration : 0, linear: true});
  }

  focus(id: string, card: HTMLElement, animate = true) {
    const center = this.positions.get(id);
    if (!center) return;
    this.closePreview();
    this.selected = {id, card};
    const compact = innerWidth <= 900;
    const anchor = compact ? 'top' : 'left';
    this.preview = new maplibregl.Popup({anchor, offset: compact ? [0, 4] : [27, -25],
      className: 'activity-popup', closeButton: false, closeOnClick: false, focusAfterOpen: false, maxWidth: 'none'})
      .setLngLat(center).setDOMContent(card).addTo(this.map);
    // Reserve enough room for the card, the pin and the activity index.
    const pinX = compact ? innerWidth / 2 : (innerWidth + Math.min(305, innerWidth * 0.29) - card.offsetWidth) / 2;
    const pinY = compact ? Math.max(66, (innerHeight - card.offsetHeight) / 2) : innerHeight / 2;
    this.map.easeTo({center, zoom: Math.max(this.map.getZoom(), 15), offset: [pinX-innerWidth/2, pinY-innerHeight/2],
      duration: animate && !this.instant ? 450 : 0});
  }

  closePreview() {
    this.selected = undefined;
    this.preview?.remove();
    this.preview = undefined;
  }
  zoom(by: number) { this.map.zoomTo(this.map.getZoom() + by, {duration: 200}); }

  private waypointControls(text: string, picking: boolean) {
    document.querySelector<HTMLElement>('#waypoint-control')!.hidden = !text;
    document.querySelector('#waypoint-status')!.textContent = text;
    document.querySelector<HTMLElement>('#pin-center')!.hidden = !picking;
    document.querySelector<HTMLElement>('#host-here')!.hidden = picking || !text;
    document.querySelector('#pin-clear')!.textContent = picking ? 'Cancel' : 'Clear';
  }

  clearWaypoint() {
    this.waypoint?.remove();
    this.waypoint = undefined;
    this.picking = false;
    document.body.classList.remove('picking');
    document.querySelector('#pin-mode')!.setAttribute('aria-pressed', 'false');
    this.waypointControls('', false);
  }

  private placeWaypoint(at: maplibregl.LngLat) {
    this.clearWaypoint();
    const element = document.createElement('div');
    element.className = 'custom-waypoint';
    element.innerHTML = '<i></i><span>Waypoint</span>';
    this.waypoint = new maplibregl.Marker({element, anchor:'bottom'}).setLngLat(at).addTo(this.map);
    const km = at.distanceTo(maplibregl.LngLat.convert(this.origin)) / 1000;
    this.waypointControls(`Waypoint · ${km.toFixed(1)} km from area center`, false);
  }
}
