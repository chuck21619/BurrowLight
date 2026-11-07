import { startServer } from './server';

// GAME_PORT, not PORT: dev tools often set PORT for the web client, and the two must differ.
const port = Number(process.env.GAME_PORT ?? 8787);
const server = await startServer(port);
console.log(`Burrowlight server listening on http://localhost:${server.port} (WebSocket at /ws)`);

const shutdown = () => {
  server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
