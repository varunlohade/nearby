import { cityApi } from '../server/city.js';
// Vercel Function: every /api/* request lands here (see vercel.json) and runs
// through the same route handlers the Vite dev server uses.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { askApi } from '../server/ask.js';
import { lumaApi } from '../server/luma.js';
import { nexconnApi } from '../server/nexconn.js';
import { placesApi } from '../server/places.js';
import { agentsApi } from '../server/agents.js';
import { communitiesApi } from '../server/communities.js';
import { configureGuard } from '../server/guard.js';
import { configureIdentity } from '../server/identity.js';

type Handler = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown;

const env = process.env;
configureIdentity(env.IDENTITY_SECRET || env.NEXCONN_APP_SECRET || '');
configureGuard(env.ANTHROPIC_API_KEY ?? '');
const handlers: Handler[] = [
  nexconnApi({ appKey: env.NEXCONN_APP_KEY ?? '', secret: env.NEXCONN_APP_SECRET ?? '', host: env.NEXCONN_API_HOST || 'api.sg-light-api.com' }),
  cityApi, lumaApi,
  askApi(env.ANTHROPIC_API_KEY ?? '', { id: env.REDDIT_CLIENT_ID, secret: env.REDDIT_CLIENT_SECRET }),
  placesApi(env.TURN_URLS, env.TURN_SHARED_SECRET),
  communitiesApi(),
  agentsApi(),
];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // vercel.json rewrites /api/<path>?<query> to /api?__path=<path>&<query>; restore the original URL.
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.searchParams.get('__path');
  if (path !== null) {
    // Vercel also passes the captured route as a query parameter; drop both helpers.
    url.searchParams.delete('__path');
    url.searchParams.delete('__route');
    const query = url.searchParams.toString();
    req.url = '/api/' + path + (query ? '?' + query : '');
  }
  let index = 0;
  const next = async (error?: unknown): Promise<void> => {
    if (error) { console.error('[api]', error); if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); } return; }
    const run = handlers[index++];
    if (!run) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Not found' })); return; }
    try { await run(req, res, next); } catch (e) { await next(e); }
  };
  await next();
}
