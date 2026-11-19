import type { Area, Happening, LatLng } from '../types';

export interface MapView {
  /** Draw or redraw an area outline and its light wall. */
  setArea(area: Area, mine: boolean): void;
  /** Show a happening (3D effect + clickable label); returns a function that removes it. */
  addHappening(h: Happening, labelHtml: string, onClick: () => void): () => void;
  /** Click on the map that did not hit a happening. */
  onMapClick(cb: (at: LatLng) => void): void;
  flyTo(at: LatLng, close?: boolean): void;
  project(at: LatLng): { x: number; y: number };
  onMove(cb: () => void): void;
}
