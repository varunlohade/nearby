import type { IncomingMessage, ServerResponse } from 'node:http';

interface Listing {
  event?: {
    api_id: string; name: string; url: string; visibility: string; location_type: string;
    geo_address_visibility: string; geo_address_info?: {address?: string; city_state?: string};
    coordinate?: {latitude: number; longitude: number}; start_at: string; end_at: string;
    cover_url?: string; hide_rsvp?: boolean; canceled_at?: string;
  };
  guest_count?: number;
}

async function discover(lat: number, lng: number) {
  const url = new URL('https://api2.luma.com/discover/get-paginated-events');
  url.search = new URLSearchParams({latitude:String(lat), longitude:String(lng), pagination_limit:'50'}).toString();
  const response = await fetch(url, {signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('Discover unavailable');
  const {entries} = await response.json() as {entries: Listing[]};
  return entries.flatMap(({event, guest_count}) => {
    const at = event?.coordinate;
    if (!event || !at || event.visibility !== 'public' || event.geo_address_visibility !== 'public' ||
        event.location_type !== 'offline' || event.canceled_at || !Number.isFinite(at.latitude) || !Number.isFinite(at.longitude) ||
        !/^[\w-]+$/.test(event.api_id) || !/^[\w-]+$/.test(event.url) || !(Date.parse(event.end_at) > Date.now())) return [];
    return [{id:event.api_id, title:event.name, url:'https://luma.com/' + event.url,
      cover:event.cover_url?.startsWith('https://images.lumacdn.com/') ? event.cover_url : undefined,
      venue:event.geo_address_info?.address || event.geo_address_info?.city_state || 'Public venue',
      lat:at.latitude, lng:at.longitude, start:event.start_at, end:event.end_at,
      count:event.hide_rsvp || !Number.isInteger(guest_count) ? null : guest_count}];
  });
}
const cache = new Map<string,{until:number; results:ReturnType<typeof discover>}>();
export async function lumaApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/api/luma/nearby') return next();
  const send = (code:number, body:unknown) => {
    res.writeHead(code, {'Content-Type':'application/json','Cache-Control':code === 200 ? 'public,max-age=60' : 'no-store'});
    res.end(JSON.stringify(body));
  };
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
  if (req.method !== 'GET') return send(405,{error:'GET required'});
  if (!url.searchParams.get('lat') || !url.searchParams.get('lng') || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat)>90 || Math.abs(lng)>180) return send(400,{error:'Invalid area'});
  const key = lat.toFixed(1) + ',' + lng.toFixed(1);
  let hit = cache.get(key);
  if (!hit || hit.until <= Date.now()) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    hit = {until:Date.now()+300000, results:discover(Number(lat.toFixed(1)),Number(lng.toFixed(1)))};
    cache.set(key,hit);
  }
  try {
    const events = (await hit.results).map(event => {
      const rad = Math.PI/180;
      const hav = Math.sin((event.lat-lat)*rad/2)**2 + Math.cos(lat*rad)*Math.cos(event.lat*rad)*Math.sin((event.lng-lng)*rad/2)**2;
      return {...event,distance:12742*Math.asin(Math.sqrt(Math.min(1,hav)))};
    }).filter(e=>e.distance <= 50 && Date.parse(e.end)>Date.now()).sort((a,b)=>a.distance-b.distance);
    send(200,{events});
  } catch { if (hit === cache.get(key)) cache.delete(key); send(502,{error:'Luma listings unavailable'}); }
}
