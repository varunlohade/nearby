// Sample listings so an empty city marketplace has something to try.
//
// Each city is seeded at most once a week (an atomic counter with a TTL), and
// only when it has fewer than six open listings. Ids are deterministic UUIDs
// from the city key, and writes use compareRevision expecting revision 0, so
// concurrent first visits never create duplicates. Every sample is owned by a
// stable "Sample seller", marked `sample: true` and badged in the UI.

import { createHash } from 'node:crypto';
import type { Store } from './store.js';

export const SAMPLE_OWNER = { id: 'nearby-sample', name: 'Sample seller' };
export const SAMPLE_REPLY = 'Hi! This is a sample listing so you can try the marketplace. ' +
  'Nothing is for sale here, but real neighbours list things the same way: tap "+ List something" to sell your own.';

const CURRENCY: [RegExp, string, number][] = [
  // [country pattern, currency, rough multiplier from USD]
  [/\bindia\b/, 'INR', 80], [/united kingdom|\buk\b|england|scotland|wales/, 'GBP', 0.8],
  [/singapore/, 'SGD', 1.35], [/japan/, 'JPY', 150], [/australia/, 'AUD', 1.5], [/canada/, 'CAD', 1.35],
  [/united arab emirates|\buae\b/, 'AED', 3.7], [/germany|france|spain|italy|netherlands|ireland|portugal|belgium|austria|finland|greece/, 'EUR', 0.92],
  [/united states|\busa\b/, 'USD', 1], [/indonesia/, 'IDR', 15500], [/philippines/, 'PHP', 56], [/thailand/, 'THB', 35],
  [/malaysia/, 'MYR', 4.6], [/brazil/, 'BRL', 5], [/mexico/, 'MXN', 17], [/south africa/, 'ZAR', 18], [/nigeria/, 'NGN', 1500],
  [/kenya/, 'KES', 130], [/switzerland/, 'CHF', 0.9], [/sweden/, 'SEK', 10.5], [/norway/, 'NOK', 10.5], [/denmark/, 'DKK', 6.9],
  [/new zealand/, 'NZD', 1.65], [/south korea|korea/, 'KRW', 1350], [/china/, 'CNY', 7.2], [/pakistan/, 'PKR', 280],
  [/bangladesh/, 'BDT', 110], [/sri lanka/, 'LKR', 300], [/nepal/, 'NPR', 133], [/turkey|türkiye/, 'TRY', 33],
  [/saudi arabia/, 'SAR', 3.75], [/egypt/, 'EGP', 48], [/vietnam/, 'VND', 25000], [/hong kong/, 'HKD', 7.8],
];

// [title, description, price in USD, dibs]
const ITEMS: [string, string, number, boolean][] = [
  ['Hybrid bicycle, 21 gears', 'Light city bike, new tyres last year. Small scratch on the frame. Lock included.', 90, true],
  ['Wooden study table', 'Solid wood, 120 × 60 cm. Fits a laptop and books. Pick up only.', 45, true],
  ['Box of 20 novels', 'Mix of thrillers and classics in English. Good condition. Take all.', 15, false],
  ['Monstera plant in pot', 'Healthy, about 80 cm tall. Ceramic pot included.', 18, true],
  ['Kids scooter (ages 4–8)', 'Three wheels, adjustable handle. Lights up when moving.', 20, true],
  ['Badminton set with 4 rackets', 'Rackets, net and a tube of shuttles. Used a few weekends.', 25, false],
  ['Microwave oven, 20 L', 'Works well, moving out so must go. Clean inside.', 40, true],
  ['Bluetooth speaker', 'Water resistant, 10-hour battery. Charger included.', 22, false],
  ['Yoga mat and blocks', 'Thick 6 mm mat plus two foam blocks. Washed.', 12, false],
  ['Office chair, mesh back', 'Adjustable height and arms. One wheel slightly squeaky.', 35, true],
  ['Baby stroller', 'Folds flat, rain cover included. From a smoke-free home.', 55, true],
  ['Cricket bat and pads', 'Full-size willow bat plus junior pads. Good for practice.', 30, false],
  ['Table lamp, warm light', 'Matte black, works with any E27 bulb (bulb included).', 10, false],
  ['Electric kettle, 1.5 L', 'Auto shut-off, barely used. Box included.', 12, false],
];

function currency(scope: string) {
  const country = scope.split('|')[0] ?? '';
  for (const [pattern, code, rate] of CURRENCY) if (pattern.test(country)) return { code, rate };
  return { code: 'USD', rate: 1 };
}

function price(usd: number, rate: number) {
  const value = usd * rate;
  // Round to a natural local step: 50 for INR-sized currencies, 1 for USD-sized ones.
  const step = rate >= 1000 ? 1000 : rate >= 50 ? 50 : rate >= 5 ? 5 : 1;
  return Math.max(step, Math.round(value / step) * step);
}

/** Deterministic UUID-format id for sample `index` in this city. */
function sampleId(key: string, index: number) {
  const h = createHash('sha256').update(key + ':sample:' + index).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Seed this city's market once a week when it has fewer than six open listings. */
export async function seedMarket(store: Store, key: string, scope: string, openCount: number) {
  if (openCount >= 6) return false;
  // incrWindow is atomic: only the first caller in a week seeds.
  if ((await store.incrWindow('seeded:' + key, 7 * 86400)) !== 1) return false;
  const parts = scope.split('|').map(p => p.trim()).filter(Boolean);
  const town = parts.at(-1) || 'your area';
  const title = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase());
  const spots = [`Near ${title(town)} market`, `${title(town)} main road`, `By the ${title(town)} park`, `${title(town)} metro area`, `Off ${title(town)} high street`];
  const { code, rate } = currency(scope);
  const now = Date.now();
  await Promise.all(ITEMS.map(([name, description, usd, dibs], i) => store.compareRevision(key, sampleId(key, i), 0, <{ revision: number }>{
    id: sampleId(key, i), owner: SAMPLE_OWNER, title: name, venue: spots[i % spots.length],
    created: now - i * 37 * 60_000, revision: 1, kind: 'item', dibs, sample: true,
    price: `${code} ${price(usd, rate)}`, description, closed: false, queue: [], until: 0, messages: [],
  })));
  return true;
}
