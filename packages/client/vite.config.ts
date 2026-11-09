import { defineConfig } from 'vite';

export default defineConfig({
  // Build for older phones too (iPhones from about iOS 13, Android Chrome 80+).
  build: { target: ['es2019', 'safari13', 'chrome80'] },
  server: {
    port: 5173,
    // The game server runs separately on 8787; Vite forwards WebSocket traffic to it.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
