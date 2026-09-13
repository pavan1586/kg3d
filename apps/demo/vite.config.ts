import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The demo consumes the packages from their compiled `dist` output rather than
 * from source. That is deliberate: the layout controller resolves its worker
 * with `new URL('./layoutWorker.js', import.meta.url)`, which only points at a
 * real file once tsc has emitted it. Building first also means the demo
 * exercises exactly what a consumer installs from npm.
 *
 * `npm run dev` builds both packages before starting Vite.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kg3d/core': fileURLToPath(new URL('../../packages/core/dist/index.js', import.meta.url)),
      '@kg3d/react': fileURLToPath(new URL('../../packages/react/dist/index.js', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['@kg3d/core', '@kg3d/react'],
  },
  // The same proxy is needed in `preview` as in `dev`: the built demo talks to
  // the FastAPI service on a different port, and routing it through Vite keeps
  // the browser on one origin so CORS never enters into it.
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.KG3D_API ?? 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: process.env.KG3D_API ?? 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
});
