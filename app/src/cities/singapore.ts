import type { CityConfig } from '../types';

export const SINGAPORE: CityConfig = {
  id: 'singapore',
  name: 'Singapore',
  center: { lat: 1.2930, lng: 103.8520 },
  heading: -20,
  zoom: 13.1,
  areas: [
    { id: 'marina', name: 'Marina Bay', center: { lat: 1.2830, lng: 103.8590 }, radiusKm: 1.0, hereNow: 231 },
    { id: 'chinatown', name: 'Chinatown', center: { lat: 1.2820, lng: 103.8440 }, radiusKm: 0.8, hereNow: 164 },
    { id: 'tiongbahru', name: 'Tiong Bahru', center: { lat: 1.2850, lng: 103.8300 }, radiusKm: 0.7, hereNow: 58 },
    { id: 'orchard', name: 'Orchard', center: { lat: 1.3040, lng: 103.8320 }, radiusKm: 1.0, hereNow: 190 },
    { id: 'bugis', name: 'Bugis', center: { lat: 1.3000, lng: 103.8560 }, radiusKm: 0.8, hereNow: 120 },
    { id: 'kallang', name: 'Kallang', center: { lat: 1.3035, lng: 103.8740 }, radiusKm: 0.9, hereNow: 77 },
  ],
  happenings: [
    { kind: 'concert', title: 'Free concert at the waterfront', place: 'Esplanade Outdoor Theatre', when: 'Tonight, 8 pm', at: { lat: 1.2897, lng: 103.8555 }, areaId: 'marina', people: 300 },
    { kind: 'ride', title: 'Bay loop run', place: 'Marina Bay promenade', when: 'Sat, 7 am', at: { lat: 1.2834, lng: 103.8607 }, areaId: 'marina', people: 41 },
    { kind: 'market', title: 'Satay street opens', place: 'Lau Pa Sat', when: 'From 7 pm', at: { lat: 1.2806, lng: 103.8504 }, areaId: 'chinatown', people: 180 },
    { kind: 'market', title: 'Hawker breakfast crowd', place: 'Chinatown Complex', when: 'Now', at: { lat: 1.2823, lng: 103.8430 }, areaId: 'chinatown', people: 95 },
    { kind: 'help', title: 'Lost a blue umbrella', place: 'Tiong Bahru Market', when: '10 min ago', at: { lat: 1.2850, lng: 103.8327 }, areaId: 'tiongbahru', people: 2 },
    { kind: 'concert', title: 'Busker set', place: 'ION Orchard plaza', when: 'Now', at: { lat: 1.3040, lng: 103.8318 }, areaId: 'orchard', people: 60 },
    { kind: 'market', title: 'Night bazaar', place: 'Bugis Street', when: 'Till 11 pm', at: { lat: 1.3006, lng: 103.8551 }, areaId: 'bugis', people: 140 },
    { kind: 'help', title: 'Need a hand moving a sofa', place: 'Haji Lane', when: 'Now', at: { lat: 1.3006, lng: 103.8590 }, areaId: 'bugis', people: 2 },
    { kind: 'match', title: 'Lions friendly', place: 'National Stadium', when: 'Sat, 7:30 pm', at: { lat: 1.3040, lng: 103.8746 }, areaId: 'kallang', people: 1200 },
    { kind: 'ride', title: 'Park connector ride', place: 'Kallang Riverside', when: 'Sun, 6:30 am', at: { lat: 1.3010, lng: 103.8680 }, areaId: 'kallang', people: 19 },
    { kind: 'joined', title: '5 people joined', place: 'Orchard Rd', when: 'Just now', at: { lat: 1.3020, lng: 103.8360 }, areaId: 'orchard', people: 5 },
  ],
  chats: [
    { areaId: 'marina', name: 'Wei', text: 'Light show at 8 and 9 tonight.' },
    { areaId: 'chinatown', name: 'Priya', text: 'Queue at the chicken rice stall is short now.' },
    { areaId: 'orchard', name: 'Jun', text: 'Rain in 20 minutes, take the underpass.' },
    { areaId: 'bugis', name: 'Aisha', text: 'Anyone up for kopi at 4?' },
    { areaId: 'kallang', name: 'Marcus', text: 'Stadium roof is open tonight.' },
    { areaId: 'tiongbahru', name: 'Lena', text: 'New bakery opened near the market.' },
  ],
};
