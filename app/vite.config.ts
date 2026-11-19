import { defineConfig, loadEnv } from 'vite';
import { nexconnApi } from './server/nexconn';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const appKey = env.NEXCONN_APP_KEY ?? '';
  const secret = env.NEXCONN_APP_SECRET ?? '';
  const host = env.NEXCONN_API_HOST || 'api.sg-light-api.com';
  const api = nexconnApi({ appKey, secret, host });
  return {
    envDir: '..',
    define: {
      __NEXCONN_APP_KEY__: JSON.stringify(appKey),
      __NEXCONN_SERVER__: JSON.stringify(Boolean(appKey && secret)),
    },
    plugins: [
      {
        name: 'nexconn-api',
        configureServer(server) { server.middlewares.use(api); },
        configurePreviewServer(server) { server.middlewares.use(api); },
      },
    ],
  };
});
