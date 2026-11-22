import type { Place } from '../world/earth';

export function cityScope(place: Place): string {
  if (!place.city || place.city === 'Your location' || place.city.includes('°')) return '';
  return [place.country, place.region, place.city || place.locality]
    .map(value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()).join('|');
}
