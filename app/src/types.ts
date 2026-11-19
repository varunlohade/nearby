export interface LatLng {
  lat: number;
  lng: number;
}

export interface Area {
  id: string;
  name: string;
  center: LatLng;
  /** Rough radius in km, used to draw the outline. */
  radiusKm: number;
  /** Outline ring, first point repeated at the end. */
  ring: LatLng[];
  hereNow: number;
  founder?: string;
}

export type HappeningKind = 'concert' | 'market' | 'match' | 'ride' | 'help' | 'joined';

export interface Happening {
  id: string;
  kind: HappeningKind;
  title: string;
  place: string;
  when: string;
  at: LatLng;
  areaId: string;
  people: number;
}

export interface AreaSeed {
  id: string;
  name: string;
  center: LatLng;
  radiusKm: number;
  hereNow: number;
}

export interface CityConfig {
  id: string;
  name: string;
  center: LatLng;
  heading: number;
  /** Camera zoom after the intro. Buildings load from zoom 13. */
  zoom: number;
  areas: AreaSeed[];
  happenings: Omit<Happening, 'id'>[];
  /** Seed chat lines per area for the demo chat. */
  chats: { areaId: string; name: string; text: string }[];
}
