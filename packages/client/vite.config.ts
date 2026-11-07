import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The game server runs separately on 8787; Vite forwards WebSocket traffic to it.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
