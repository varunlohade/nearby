import { cityApi } from './server/city';
import { configureFixtures, fixturesApi } from './server/fixtures';
import { askApi } from './server/ask';
import { placesApi } from './server/places';
import { lumaApi } from './server/luma';
import { defineConfig, loadEnv } from 'vite';
import { nexconnApi } from './server/nexconn';
import { agentsApi } from './server/agents';
import { communitiesApi } from './server/communities';
import { configureGuard } from './server/guard';
import { configureIdentity } from './server/identity';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const appKey = env.NEXCONN_APP_KEY ?? '';
  const secret = env.NEXCONN_APP_SECRET ?? '';
  const host = env.NEXCONN_API_HOST || 'api.sg-light-api.com';
  const api = nexconnApi({ appKey, secret, host });
  const ask = askApi(env.ANTHROPIC_API_KEY ?? '', { id: env.REDDIT_CLIENT_ID, secret: env.REDDIT_CLIENT_SECRET });
  const places = placesApi(env.TURN_URLS, env.TURN_SHARED_SECRET);
  configureIdentity(env.IDENTITY_SECRET || secret);
  configureGuard(env.ANTHROPIC_API_KEY ?? '');
  configureFixtures(env.ANTHROPIC_API_KEY ?? '');
  const communities = communitiesApi();
  const agents = agentsApi();
  return {
    envDir: '..',
    plugins: [
      {
        name: 'nexconn-api',
        configureServer(server) { for (const m of [fixturesApi, cityApi, api, lumaApi, ask, places, communities, agents]) server.middlewares.use(m); },
        configurePreviewServer(server) { for (const m of [fixturesApi, cityApi, api, lumaApi, ask, places, communities, agents]) server.middlewares.use(m); },
      },
    ],
  };
});
