# Burrowlight

A cozy co-op roguelike for the browser: 2–4 critters on a shared grid that runs on server ticks.
Design doc: https://claude.ai/artifact/8dePGRmN1qh9AiRutRCPMW

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173, click **Make a burrow**, then open the invite link in a second tab (or another browser) to join as a second player. Everyone presses **I'm ready**, and the host starts the run.

Controls: WASD or arrow keys to move (two keys at once for diagonals), numpad works too, `.` to wait.

## Layout

| Package | What it holds |
| --- | --- |
| `packages/shared` | Game rules used by both sides: seeded RNG, map generation, field of view, action costs, the tick simulation, message types |
| `packages/server` | Node + `ws`: rooms with 5-letter join codes, the authoritative 10 Hz game loop, rejoin tokens, rate limits |
| `packages/client` | Vite + PixiJS: lobby, renderer, client-side prediction and smoothing, HUD |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Game server on :8787 (`GAME_PORT` to change) and Vite on :5173 |
| `npm test` | Vitest: rules, map generation, FOV, tick sim, and an end-to-end WebSocket game |
| `npm run typecheck` | TypeScript across all three packages |
| `npm run build` then `npm start` | Production: the server also serves the built client on :8787 |

## Milestone status

**M1 (walk around together): done.** Lobby with join codes, one generated Rootcellar floor, 2–4 players moving on the tick system with prediction and smoothing, field of view with a party-shared explored map, placeholder pixel tiles, reconnect within 60 s.

Next is M2: HP, bump-to-attack, the first enemies, knock-outs, wisps and the Mending Shrine.
