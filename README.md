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

## Putting it online (Render free tier)

The repo includes `render.yaml`, so Render can set everything up from it:

1. Push this repo to GitHub (a private repo is fine).
2. Sign in to [Render](https://render.com) with GitHub, then choose **New → Blueprint** and pick the repo. Render reads `render.yaml` and creates one free web service called `burrowlight`.
3. When the build finishes, open the `https://burrowlight-….onrender.com` address it gives you and share it with friends.

Notes on the free tier: the service goes to sleep after about 15 minutes with no visitors and takes up to a minute to wake on the next visit. Games in progress live in memory, so a restart or a new deploy ends them. Dev-only options (`?floor=` and `?seed=`) are ignored in production.
