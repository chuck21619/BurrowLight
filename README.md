# Burrowlight

A cozy co-op puzzle roguelike for the browser. Two to eight little critters with lanterns go down
through nine dark floors, bringing light back to the Heartstones before their oil runs out or the
dark gives everyone the Jitters.

**Play it:** https://burrowlight.onrender.com — make a burrow, send friends the invite link, and
start when everyone is ready. (It's on a free server: the first visit after a quiet spell can take
up to a minute to wake up.)

## How to play

Every floor is pitch black. Light every **Heartstone** to open the hatch, then gather on the
ladder to go down. Any light charges a Heartstone, and more light charges it faster.

- **Lanterns** light the way but burn oil. Lanterns side by side add up.
- **Sunshafts, sunbeams and torches** are free light. Turn **mirrors** to steer sunbeams.
- **The Jitters** fill up in the dark (slower next to a friend). A full meter means panic, and if
  everyone panics at once, the run is over.
- **Traps** hide in the dark. Light reveals them.
- **Burrowing:** push into a wall from dirt ground to dig a tunnel underneath it. Each critter
  brings one burrow brace per floor, and tunnels are permanent for everyone.
- **Locked pens** open with a pressure plate (someone stands on it) or a sun gem (catch a sunbeam
  in it).
- **Talents:** you earn a point each floor. Spend them in four trees: Light, Burrowing, Tinker
  and Kindle.
- **Gear** is unlocked by achievements and kept between runs in your browser.
- Each act ends with a boss you outwit rather than fight: the Gloom, the Mothmother and the
  Sleeping Giant.

### Controls

| Key | Does |
| --- | --- |
| WASD / arrow keys | Move (two keys for diagonals) |
| Space | Lantern on or off |
| E | Turn a mirror, or use a talent on a friend or trap next to you |
| Push into a wall, then Enter | Dig a tunnel |
| Q | Go through a tunnel you're standing on |
| R | Set down or pick up your Mirror Pack mirror (talent) |
| T | Talents |
| M | Sound on or off |

## Running it yourself

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click **Make a burrow**. Open the invite link in a second tab to
join as another player. In development, `?floor=N` starts on floor N and `?seed=N` replays a
run.

| Command | Does |
| --- | --- |
| `npm run dev` | Game server on :8787 and the Vite client on :5173 |
| `npm test` | Vitest: rules, map generation, bosses, gear and an end-to-end WebSocket game |
| `npm run typecheck` | TypeScript across all three packages |
| `npm run build` then `npm start` | Production: one server that also serves the built client |

`render.yaml` describes the hosted version (one free Render web service).

## How it's built

| Package | What it holds |
| --- | --- |
| `packages/shared` | The game itself: seeded floor generation, light and field of view, sunbeams, the 10 Hz tick simulation, bosses, talents, gear and message types |
| `packages/server` | Node + `ws`: rooms with 5-letter codes, the authoritative game loop, rejoin tokens and rate limits |
| `packages/client` | Vite + PixiJS: lobby, rendering, client-side prediction, HUD, sound, and all the pixel art (drawn in code) |
