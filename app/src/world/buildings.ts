import maplibregl, {type ExpressionSpecification} from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';

// The prototype uses Overture's inspection tiles. A deployment can supply its own archive.
const archive = import.meta.env.VITE_BUILDINGS_PMTILES ||
  'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-11-18.0/buildings.pmtiles';
const tiles = new PMTiles(archive);
const protocol = new Protocol();
protocol.add(tiles);
maplibregl.addProtocol('pmtiles', protocol.tile);

const palette: ExpressionSpecification = ['match', ['get','class'],
  'stadium','#d4c7a5', 'industrial','#97acb6','commercial','#cd9b80',
  'hospital','#c7a2ab','school','#e0bd89',
  ['at',['%', ['max',0,['index-of',['slice',['to-string',['get','id']],0,1],'0123456789abcdef'] ],5],
    ['literal',['#bbc0b1','#b79c96','#aaacba','#c7b394','#aab9ba']]]];

export class BuildingTiles {
  private active = false;
  constructor(private map: maplibregl.Map) {
    map.on('idle', () => {
      if (!this.active) return;
      const available = map.queryRenderedFeatures(undefined,{layers:['sat-building','sat-building_part']}).length > 0;
      const visibility = available ? 'none' : 'visible';
      if (map.getLayoutProperty('buildings-3d','visibility') !== visibility)
        map.setLayoutProperty('buildings-3d','visibility',visibility);
    });
  }

  private warmup?: AbortController;

  prepare(lng: number, lat: number) {
    this.warmup?.abort();
    this.warmup = new AbortController();
    const z = 14, scale = 2 ** z;
    const x = Math.floor((lng + 180) / 360 * scale) % scale;
    const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) * scale / 2);
    // Fetch the arrival block during the globe flight. The browser can reuse its range response.
    void tiles.getZxy(z,x,y,this.warmup.signal).catch(() => {});
  }

  show(active: boolean) {
    this.active = active;
    if (!this.map.getSource('overture')) {
      if (!active) return;
      this.map.addSource('overture',{type:'vector',url:'pmtiles://'+archive});
      for (const layer of ['building','building_part']) {
        this.map.addLayer({id:'sat-'+layer,type:'fill-extrusion',source:'overture','source-layer':layer,
          filter:['all',['!=',['get','is_underground'],true],
            ...(layer==='building' ? [['!=',['get','has_parts'],true] as ExpressionSpecification] : [])],
          paint:{
            'fill-extrusion-color':['to-color',['coalesce',['get','facade_color'],['get','roof_color'],''],palette],
            'fill-extrusion-base':['coalesce',['get','min_height'],0],
            'fill-extrusion-height':['coalesce',['get','height'],['*',3.2,['coalesce',['get','num_floors'],2]]]
          }},'label-road');
      }
    }
    for (const layer of ['sat-building','sat-building_part'])
      this.map.setLayoutProperty(layer,'visibility',active?'visible':'none');
  }
}
