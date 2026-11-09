import { startServer } from './server';

// In production (e.g. Render) the host tells us the port in PORT. In development we use GAME_PORT,
// not PORT: dev tools often set PORT for the web client, and the two must differ.
const port = Number(process.env.NODE_ENV === 'production' ? (process.env.PORT ?? 8787) : (process.env.GAME_PORT ?? 8787));
const server = await startServer(port);
console.log(`Burrowlight server listening on http://localhost:${server.port} (WebSocket at /ws)`);

const shutdown = () => {
  server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
