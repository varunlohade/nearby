import { askApi } from './server/ask';
import { placesApi } from './server/places';
import { lumaApi } from './server/luma';
import { defineConfig, loadEnv } from 'vite';
import { nexconnApi } from './server/nexconn';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const appKey = env.NEXCONN_APP_KEY ?? '';
  const secret = env.NEXCONN_APP_SECRET ?? '';
  const host = env.NEXCONN_API_HOST || 'api.sg-light-api.com';
  const api = nexconnApi({ appKey, secret, host });
  const ask = askApi(env.ANTHROPIC_API_KEY ?? '', { id: env.REDDIT_CLIENT_ID, secret: env.REDDIT_CLIENT_SECRET });
  const places = placesApi();
  return {
    envDir: '..',
    plugins: [
      {
        name: 'nexconn-api',
        configureServer(server) { server.middlewares.use(api); server.middlewares.use(lumaApi); server.middlewares.use(ask); server.middlewares.use(places); },
        configurePreviewServer(server) { server.middlewares.use(api); server.middlewares.use(lumaApi); server.middlewares.use(ask); server.middlewares.use(places); },
      },
    ],
  };
});
