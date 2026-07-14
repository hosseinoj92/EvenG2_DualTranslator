import { defineConfig } from 'vite';

export default defineConfig({
  // `host: true` exposes the dev server on the LAN so a phone running the
  // Even Hub companion app can reach it via `npx evenhub qr --url http://<ip>:5173`.
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
});
