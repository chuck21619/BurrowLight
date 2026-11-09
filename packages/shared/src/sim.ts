import { traceBeam, type MirrorOrient } from './beam';
import { computeLight, type LightMap, type LightSource } from './light';
import {
  MAX_TUNNEL_SOIL,
  beamCellOf,
  canTunnelUnder,
  isDiggableGround,
  generateBossFloor,
  generateFloor,
  isWalkable,
  spawnPoints,
  tileAt,
  type FloorMap,
} from './map';
import {
  BASE_SPEED,
  DIRS,
  HEART_FADE,
  HEART_FULL,
  KO_TICKS,
  LANTERN_RADIUS,
  MAX_OIL,
  MAX_QUEUED_INTENTS,
  OIL_PER_FLOOR,
  OIL_PER_TICK,
  START_OIL,
  SUNSHAFT_RADIUS,
  BEAM_STRENGTH,
  BURROW_BRACES_PER_FLOOR,
  gloomDrain,
  GLOOM_BRIGHTNESS_WEIGHT,
  GLOOM_STEP,
  GLOOM_STEP_RESTLESS,
  GLOOM_STONE_BASE,
  GLOOM_STONE_FULL_BONUS,
  GLOOM_TORCH_BRIGHTNESS,
  GLOOM_IGNORE_TICKS,
  BOSS_INTRO_MAX,
  BOSS_INTRO_PAUSE,
  TORCH_RADIUS,
  GLOOM_TOUCH_COOLDOWN,
  GLOOM_WRIGGLE,
  GREAT_HEART_FULL,
  isBossFloor,
  JITTERS_CALM,
  JITTERS_DARK,
  JITTERS_DARK_WITH_FRIEND,
  JITTERS_MAX,
  type Dir,
  ActionCost,
  actionCost,
  heartsForParty,
  mapTile,
  resolveMove,
  type Action,
} from './rules';
import { createRng, hashSeed } from './rng';

export interface QueuedIntent {
  seq: number;
  /** null = dropped because the queue was full; resolves instantly, in order, at no cost. */
  action: Action | null;
}

export interface PlayerState {
  id: string;
  name: string;
  color: number;
  joinOrder: number;
  x: number;
  y: number;
  speed: number;
  /** First tick on which this player may act again. */
  readyAt: number;
  queue: QueuedIntent[];
  /** Highest intent sequence number the server has resolved for this player. */
  lastAck: number;
  lit: boolean;
  oil: number;
  /** Knocked out by a trap until this tick. */
  koUntil: number;
  /** The Jitters meter, 0..JITTERS_MAX. */
  jitters: number;
  /** Panicking: scurries around on its own until light calms the meter all the way down. */
  panic: boolean;
  /** Direction a panicking critter last ran in, so it dashes rather than vibrates. */
  panicDir: Dir | null;
  /** Tick the Gloom last touched this critter. */
  gloomTouchAt: number;
  /** A tunnel being dug: it opens at `until` between tile indices `a` and `b`. */
  digging: { until: number; a: number; b: number } | null;
  /** Burrow braces left on this floor: each one shores up one tunnel. */
  braces: number;
}

/** A tunnel under soft soil, between two floor tiles. Permanent, and anyone can use it. */
export interface Tunnel {
  a: number;
  b: number;
  /** Who dug it (for its color). */
  owner: string;
}

/** The act 1 boss: a 2×2 cloud of darkness. (x, y) is its top-left tile. */
export interface GloomState {
  x: number;
  y: number;
  /** A sunbeam is passing through it: it can't move, and its tether to the Great Heartstone is cut. */
  pinned: boolean;
  nextStepAt: number;
  nextWriggleAt: number;
  /** Where it's heading next (its eyes look this way). */
  dx: number;
  dy: number;
  /** 0, 1 or 2: speeds up as the Great Heartstone fills. */
  restless: number;
  /** Touching the Great Heartstone. */
  touching: boolean;
  /** Tiles between it and the Great Heartstone (0 = touching): the tether drains faster up close. */
  distance: number;
  /** What it's chasing: 'stone', 'torch', or a critter's id. */
  target: string | null;
  /** Critters it has lost interest in (got pinned while chasing them), until this tick. */
  ignore: Map<string, number>;
}

export interface HeartState {
  x: number;
  y: number;
  charge: number;
  /** Charge needed to be full (a Great Heartstone needs much more). */
  max: number;
}

export interface GameState {
  seed: number;
  floor: number;
  tick: number;
  map: FloorMap;
  players: Map<string, PlayerState>;
  /** Party-shared explored tiles (1 = has been lit at some point). */
  explored: Uint8Array;
  /** Tile indices explored during the most recent step. */
  newlyExplored: number[];
  traps: Set<number>;
  revealedTraps: Set<number>;
  newlyRevealed: number[];
  hearts: HeartState[];
  exitOpen: boolean;
  /** Mirror tile index -> current orientation. */
  mirrors: Map<number, MirrorOrient>;
  /** Sunbeams as traced this tick (tile lists, emitter first). */
  beams: number[][];
  light: LightMap;
  /** True for the step in which the party went down to a new floor. */
  descended: boolean;
  /** Everyone panicked at the same time. */
  runOver: boolean;
  /** The boss, on boss floors until the Great Heartstone is full. */
  gloom: GloomState | null;
  /** Torch tile index -> lit. */
  torches: Map<number, boolean>;
  /** Boss intro: nobody can act until this tick while the Gloom eats a torch. 0 = no intro. */
  introUntil: number;
  /** The torch the Gloom eats in its intro. */
  introTorch: number;
  /** Every tunnel dug on this floor. */
  tunnels: Tunnel[];
}

export interface NewPlayer {
  id: string;
  name: string;
  color: number;
}

export function createGame(seed: number, players: NewPlayer[], startFloor = 1): GameState {
  const state = {
    seed,
    floor: 0,
    tick: 0,
    players: new Map<string, PlayerState>(),
    runOver: false,
  } as GameState;
  players.forEach((p, i) => {
    state.players.set(p.id, {
      ...p,
      joinOrder: i,
      x: 0,
      y: 0,
      speed: BASE_SPEED,
      readyAt: 0,
      queue: [],
      lastAck: 0,
      lit: false,
      oil: START_OIL,
      koUntil: 0,
      jitters: 0,
      panic: false,
      panicDir: null,
      gloomTouchAt: -Infinity,
      digging: null,
      braces: BURROW_BRACES_PER_FLOOR,
    });
  });
  enterFloor(state, startFloor);
  return state;
}

/** Build floor `n` and put the party at its entrance. */
function enterFloor(state: GameState, n: number): void {
  const map = isBossFloor(n)
    ? generateBossFloor(hashSeed(state.seed), n)
    : generateFloor(hashSeed(state.seed), n, heartsForParty(state.players.size));
  state.floor = n;
  state.map = map;
  state.explored = new Uint8Array(map.w * map.h);
  state.newlyExplored = [];
  state.traps = new Set(map.traps);
  state.revealedTraps = new Set();
  state.newlyRevealed = [];
  state.hearts = map.hearts.map((h) => ({ x: h.x, y: h.y, charge: 0, max: map.gloomStart ? GREAT_HEART_FULL : HEART_FULL }));
  state.gloom = map.gloomStart
    ? {
        ...map.gloomStart,
        pinned: false,
        nextStepAt: state.tick + 20,
        nextWriggleAt: 0,
        dx: 0,
        dy: 0,
        restless: 0,
        touching: false,
        distance: GLOOM_DRAIN_FAR_DISTANCE,
        target: null,
        ignore: new Map(),
      }
    : null;
  state.exitOpen = false;
  state.mirrors = new Map(map.mirrors.map((m) => [m.y * map.w + m.x, m.orient]));
  state.torches = new Map(map.torches.map((t) => [t.y * map.w + t.x, t.lit]));
  state.tunnels = [];
  for (const p of state.players.values()) {
    p.digging = null;
    p.braces = BURROW_BRACES_PER_FLOOR;
  }
  state.introTorch = map.introTorch ? map.introTorch.y * map.w + map.introTorch.x : -1;
  state.introUntil = map.introTorch ? state.tick + BOSS_INTRO_MAX : 0;
  const order = [...state.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  const spawns = spawnPoints(map, map.entrance, order.length);
  order.forEach((p, i) => {
    const spot = spawns[i] ?? map.entrance;
    p.x = spot.x;
    p.y = spot.y;
    clearQueue(p);
    p.koUntil = 0;
    p.readyAt = state.tick;
  });
  updateLight(state);
}

/** Add an intent from a client. Over the limit, it is kept as a no-op so acks stay in order. */
export function queueIntent(state: GameState, playerId: string, seq: number, action: Action): void {
  const p = state.players.get(playerId);
  if (!p) return;
  const lastSeq = p.queue.length ? p.queue[p.queue.length - 1]!.seq : p.lastAck;
  if (seq <= lastSeq) return; // duplicate or out of order
  if (state.tick < p.koUntil || p.panic || state.runOver || inIntro(state)) {
    p.lastAck = seq; // seeing stars or panicking: input is dropped, not saved for later
    return;
  }
  const real = p.queue.filter((q) => q.action !== null).length;
  p.queue.push({ seq, action: real >= MAX_QUEUED_INTENTS ? null : action });
}

/** Light or douse a lantern. Can't light it without oil. Applies straight away. */
export function setLantern(state: GameState, playerId: string, on: boolean): void {
  const p = state.players.get(playerId);
  if (p && !p.panic && !state.runOver && !inIntro(state)) p.lit = on && p.oil > 0;
}

export function removePlayer(state: GameState, playerId: string): void {
  state.players.delete(playerId);
}

export interface StepOptions {
  /** Players who aren't present (disconnected) don't hold up going down a floor. */
  isPresent?: (id: string) => boolean;
}

/** Advance one tick. */
export function step(state: GameState, opts: StepOptions = {}): void {
  if (state.runOver) return;
  state.tick++;
  state.newlyExplored = [];
  state.newlyRevealed = [];
  state.descended = false;
  const order = [...state.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  const tile = mapTile(state.map);

  for (const p of order) {
    // A finished dig uses up a burrow brace and opens a permanent tunnel.
    if (p.digging && state.tick >= p.digging.until) {
      state.tunnels.push({ a: p.digging.a, b: p.digging.b, owner: p.id });
      p.braces = Math.max(0, p.braces - 1);
      p.digging = null;
    }
    if (p.panic && state.tick >= p.readyAt) {
      p.queue.push({ seq: p.lastAck, action: { kind: 'move', dir: panicStep(state, p) } });
    }
    dropNoops(p);
    if (state.tick < p.readyAt || p.queue.length === 0) continue;
    const { seq, action } = p.queue.shift()!;
    if (!action) continue;
    let cost: number;
    if (action.kind === 'move') {
      const dir = resolveMove(tile, p.x, p.y, action.dir, alliesNeverBlock);
      if (dir) {
        p.x += DIRS[dir][0];
        p.y += DIRS[dir][1];
        cost = actionCost({ kind: 'move', dir }, p.speed);
      } else {
        cost = ActionCost.blockedMove;
      }
    } else if (action.kind === 'dig') {
      const plan = p.braces > 0 ? planTunnel(state, p.x, p.y, action.dir) : null;
      if (plan) {
        p.digging = { until: state.tick + actionCost(action, p.speed), ...plan };
        cost = actionCost(action, p.speed);
      } else {
        cost = ActionCost.blockedMove;
      }
    } else if (action.kind === 'burrow') {
      // Pop out of the other end of whichever tunnel you're standing on (anyone's).
      const here = p.y * state.map.w + p.x;
      const t = state.tunnels.find((tn) => tn.a === here || tn.b === here);
      const to = t ? (here === t.a ? t.b : t.a) : -1;
      if (to >= 0) {
        p.x = to % state.map.w;
        p.y = Math.floor(to / state.map.w);
      }
      cost = actionCost(action, p.speed);
    } else if (action.kind === 'rotate') {
      // Turn the mirror you're standing on.
      const here = p.y * state.map.w + p.x;
      const m = state.mirrors.get(here);
      if (m !== undefined) state.mirrors.set(here, (1 - m) as MirrorOrient);
      cost = actionCost(action, p.speed);
    } else {
      cost = actionCost(action, p.speed);
    }
    p.readyAt = state.tick + cost;
    p.lastAck = seq;
    dropNoops(p);

    const here = p.y * state.map.w + p.x;
    if (state.traps.has(here)) {
      // Snap! Stars circle your head, and the jolt knocks your lantern out.
      p.koUntil = state.tick + KO_TICKS;
      p.lit = false;
      p.readyAt = p.koUntil;
      clearQueue(p);
      reveal(state, here);
    }
  }

  // Carrying a flame over a torch lights it.
  for (const p of order) {
    const here = p.y * state.map.w + p.x;
    if (p.lit && state.torches.get(here) === false) state.torches.set(here, true);
  }

  if (inIntro(state)) {
    // The boss introduction: everyone watches the Gloom drift to a torch and eat it.
    updateLight(state);
    const moved = updateGloom(state);
    if (gloomTouches(state, order) || moved) updateLight(state);
    if (state.torches.get(state.introTorch) === false) state.introUntil = Math.min(state.introUntil, state.tick + BOSS_INTRO_PAUSE);
    return;
  }

  for (const p of order) {
    if (!p.lit) continue;
    p.oil = Math.max(0, p.oil - OIL_PER_TICK);
    if (p.oil === 0) p.lit = false;
  }

  updateLight(state);
  const gloomMoved = updateGloom(state);
  // A snuffed lantern or eaten torch stops giving light this very tick.
  if (gloomTouches(state, order) || gloomMoved) updateLight(state);
  updateJitters(state, order);

  const g = state.gloom;
  for (const h of state.hearts) {
    const light = state.light.level[h.y * state.map.w + h.x]!;
    if (g && !g.pinned) {
      // The tether siphons off every bit of light poured in, and drains the stone: fast up close, slow far away.
      h.charge = Math.max(0, h.charge - gloomDrain(g.distance));
    } else {
      h.charge = light > 0 ? Math.min(h.max, h.charge + light) : Math.max(0, h.charge - HEART_FADE);
    }
  }
  if (!state.exitOpen && state.hearts.every((h) => h.charge >= h.max)) {
    state.exitOpen = true;
    state.gloom = null; // sun-soaked and content, it puffs away
  }

  if (state.exitOpen) {
    const present = order.filter((p) => opts.isPresent?.(p.id) ?? true);
    const s = state.map.stairs;
    if (present.length > 0 && present.every((p) => p.x === s.x && p.y === s.y)) {
      for (const p of order) p.oil = Math.min(MAX_OIL, p.oil + OIL_PER_FLOOR);
      enterFloor(state, state.floor + 1);
      state.descended = true;
    }
  }
}

/**
 * The Jitters fill in the dark (slower with a friend right next to you) and calm in any light.
 * A full meter means panic: the critter drops its lantern light and scurries off until light
 * calms it all the way down. If every critter panics at once, the run is over.
 */
function updateJitters(state: GameState, order: PlayerState[]): void {
  const { level } = state.light;
  const w = state.map.w;
  for (const p of order) {
    if (level[p.y * w + p.x]! > 0) {
      p.jitters = Math.max(0, p.jitters - JITTERS_CALM);
    } else {
      const friend = order.some((q) => q !== p && Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) <= 1);
      p.jitters = Math.min(JITTERS_MAX, p.jitters + (friend ? JITTERS_DARK_WITH_FRIEND : JITTERS_DARK));
    }
    if (!p.panic && p.jitters >= JITTERS_MAX) {
      p.panic = true;
      p.lit = false;
      p.panicDir = null;
      p.digging = null; // too scared to keep digging
      clearQueue(p);
    } else if (p.panic && p.jitters === 0) {
      p.panic = false;
    }
  }
  if (order.length > 0 && order.every((p) => p.panic)) state.runOver = true;
}

const ALL_DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** A panicking critter dashes in one direction and veers off at random. */
function panicStep(state: GameState, p: PlayerState): Dir {
  const rng = createRng(hashSeed(state.seed, state.tick, p.joinOrder));
  const tile = mapTile(state.map);
  const open = ALL_DIRS.filter((d) => resolveMove(tile, p.x, p.y, d, alliesNeverBlock) === d);
  if (p.panicDir && open.includes(p.panicDir) && rng.chance(0.8)) return p.panicDir;
  p.panicDir = open.length ? rng.pick(open) : 'n';
  return p.panicDir;
}

function dropNoops(p: PlayerState): void {
  while (p.queue.length && p.queue[0]!.action === null) p.lastAck = p.queue.shift()!.seq;
}

function clearQueue(p: PlayerState): void {
  for (const q of p.queue) p.lastAck = Math.max(p.lastAck, q.seq);
  p.queue = [];
}

/**
 * Only walls block movement. Critters and enemies walk through each other and can share a tile
 * (a design decision: blocking felt bad). Keep it this way when enemies arrive.
 */
export const alliesNeverBlock = (_x: number, _y: number): boolean => false;

export function lightSources(state: GameState): LightSource[] {
  const out: LightSource[] = [];
  for (const p of state.players.values()) if (p.lit) out.push({ x: p.x, y: p.y, radius: LANTERN_RADIUS, strength: 1 });
  for (const s of state.map.sunshafts) out.push({ x: s.x, y: s.y, radius: SUNSHAFT_RADIUS, strength: 1 });
  for (const [i, on] of state.torches) if (on) out.push({ x: i % state.map.w, y: Math.floor(i / state.map.w), radius: TORCH_RADIUS, strength: 1 });
  return out;
}

const GLOOM_DRAIN_FAR_DISTANCE = 99;

/** The four tiles the Gloom covers. */
export function gloomFootprint(w: number, x: number, y: number): number[] {
  return [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
}

const STEPS: [number, number][] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The Gloom eats light: it heads for the brightest light it can reach (lanterns, or the Great
 * Heartstone), never into a sunbeam, the only light that hurts it. A sunbeam through it pins it;
 * pinned, it wriggles one tile at a time, trying to get out of the light. Returns true if it moved.
 */
function updateGloom(state: GameState): boolean {
  const g = state.gloom;
  const heart = state.hearts[0];
  if (!g || !heart) return false;
  const { map } = state;
  const w = map.w;
  g.restless = heart.charge >= (heart.max * 2) / 3 ? 2 : heart.charge >= heart.max / 3 ? 1 : 0;
  const beamSet = new Set(state.beams.flat());
  const valid = (x: number, y: number) => gloomFootprint(w, x, y).every((i) => isWalkable(map.tiles[i]!));
  const clear = (x: number, y: number) => gloomFootprint(w, x, y).every((i) => !beamSet.has(i));
  const heartDistance = (x: number, y: number) =>
    Math.max(0, Math.min(...gloomFootprint(w, x, y).map((i) => Math.max(Math.abs((i % w) - heart.x), Math.abs(Math.floor(i / w) - heart.y)))) - 1);
  const touchesHeart = (x: number, y: number) => heartDistance(x, y) === 0;
  const settle = () => {
    g.touching = touchesHeart(g.x, g.y);
    g.distance = heartDistance(g.x, g.y);
  };

  const wasPinned = g.pinned;
  g.pinned = !clear(g.x, g.y);
  settle();
  if (g.pinned) {
    if (!wasPinned) {
      g.nextWriggleAt = state.tick + GLOOM_WRIGGLE[g.restless]!;
      // Caught while chasing someone: it loses interest in them for a while, so it doesn't hound one critter all fight.
      if (g.target && g.target !== 'stone' && g.target !== 'torch') g.ignore.set(g.target, state.tick + GLOOM_IGNORE_TICKS);
    }
    if (state.tick < g.nextWriggleAt) return false;
    g.nextWriggleAt = state.tick + GLOOM_WRIGGLE[g.restless]!;
    const options = STEPS.slice(1).filter(([dx, dy]) => valid(g.x + dx, g.y + dy));
    const free = options.filter(([dx, dy]) => clear(g.x + dx, g.y + dy));
    const rng = createRng(hashSeed(state.seed, state.tick, 7));
    const pick = free.length ? rng.pick(free) : options.length ? rng.pick(options) : null;
    if (!pick) return false;
    g.x += pick[0];
    g.y += pick[1];
    [g.dx, g.dy] = pick;
    settle();
    return true;
  }
  if (state.tick < g.nextStepAt) return false;

  // It eats light: head for the brightest light it can reach. Search outward from where it is,
  // never through a sunbeam (the only light that hurts it).
  const from = g.y * w + g.x;
  const dist = new Map<number, number>([[from, 0]]);
  const parent = new Map<number, number>();
  const queue: [number, number][] = [[g.x, g.y]];
  for (let qi = 0; qi < queue.length; qi++) {
    const [x, y] = queue[qi]!;
    const d = dist.get(y * w + x)!;
    for (const [dx, dy] of STEPS.slice(1)) {
      const nx = x + dx;
      const ny = y + dy;
      const k = ny * w + nx;
      if (dist.has(k) || !valid(nx, ny) || !clear(nx, ny)) continue;
      dist.set(k, d + 1);
      parent.set(k, y * w + x);
      queue.push([nx, ny]);
    }
  }
  const target = chooseLight(state, dist, touchesHeart);
  g.nextStepAt = state.tick + (g.restless ? GLOOM_STEP_RESTLESS : GLOOM_STEP);
  g.target = target?.what ?? null;
  if (!target) return false;
  // Eyes on the prize.
  const cx = g.x + 0.5;
  const cy = g.y + 0.5;
  g.dx = Math.sign(Math.round(target.lookX - cx)) || 0;
  g.dy = Math.sign(Math.round(target.lookY - cy)) || 0;
  if (target.spot === from) return false;
  let next = target.spot;
  while (parent.get(next) !== from) next = parent.get(next)!;
  g.x = next % w;
  g.y = Math.floor(next / w);
  settle();
  return true;
}

interface LightTarget {
  /** 'stone', 'torch', or a critter's id. */
  what: string;
  /** The Gloom position (top-left index) to head for. */
  spot: number;
  /** Where its eyes should look. */
  lookX: number;
  lookY: number;
}

/**
 * The Gloom wants the brightest light it can reach, weighed against how far away it is.
 * Lanterns stack: critters standing together are a brighter, juicier target. The Great
 * Heartstone glows brighter as it charges, so it pulls harder the fuller it gets.
 */
function chooseLight(state: GameState, dist: Map<number, number>, touchesHeart: (x: number, y: number) => boolean): LightTarget | null {
  const { map } = state;
  const w = map.w;
  const heart = state.hearts[0]!;
  let best: LightTarget | null = null;
  let bestScore = -Infinity;
  const consider = (what: string, spot: number, brightness: number, lookX: number, lookY: number) => {
    const d = dist.get(spot);
    if (d === undefined) return;
    const score = brightness * GLOOM_BRIGHTNESS_WEIGHT - d;
    if (score > bestScore) {
      bestScore = score;
      best = { what, spot, lookX, lookY };
    }
  };
  const covering = (x: number, y: number) =>
    [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ].map(([ox, oy]) => (y + oy!) * w + x + ox!);
  if (inIntro(state)) {
    // Its introduction: it only wants the torch it's about to eat.
    const tx = state.introTorch % w;
    const ty = Math.floor(state.introTorch / w);
    if (state.torches.get(state.introTorch)) for (const s of covering(tx, ty)) consider('torch', s, 1, tx, ty);
    return best;
  }
  // The Great Heartstone: any spot touching it.
  const stoneBrightness = GLOOM_STONE_BASE + GLOOM_STONE_FULL_BONUS * (heart.charge / heart.max);
  for (const k of dist.keys()) if (touchesHeart(k % w, Math.floor(k / w))) consider('stone', k, stoneBrightness, heart.x, heart.y);
  // Lit torches.
  for (const [i, on] of state.torches) {
    if (!on) continue;
    for (const s of covering(i % w, Math.floor(i / w))) consider('torch', s, GLOOM_TORCH_BRIGHTNESS, i % w, Math.floor(i / w));
  }
  // Lit lanterns: a spot whose footprint covers the critter (so it can eat the light). Not critters it's lost interest in.
  const g = state.gloom!;
  const lit = [...state.players.values()].filter((p) => p.lit);
  for (const p of lit) {
    if ((g.ignore.get(p.id) ?? 0) > state.tick) continue;
    const stack = lit.filter((q) => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) <= 1).length;
    for (const [ox, oy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ]) {
      consider(p.id, (p.y + oy) * w + p.x + ox, stack, p.x, p.y);
    }
  }
  return best;
}

/** Drifting through a critter snuffs its lantern and gives it a big burst of the Jitters. */
function gloomTouches(state: GameState, order: PlayerState[]): boolean {
  const g = state.gloom;
  if (!g) return false;
  let snuffed = false;
  // It eats lit torches it drifts over.
  for (const i of gloomFootprint(state.map.w, g.x, g.y)) {
    if (state.torches.get(i)) {
      state.torches.set(i, false);
      snuffed = true;
    }
  }
  const foot = new Set(gloomFootprint(state.map.w, g.x, g.y));
  for (const p of order) {
    if (!foot.has(p.y * state.map.w + p.x) || state.tick - p.gloomTouchAt < GLOOM_TOUCH_COOLDOWN) continue;
    p.gloomTouchAt = state.tick;
    snuffed ||= p.lit;
    p.lit = false;
    p.jitters = Math.min(JITTERS_MAX, p.jitters + JITTERS_MAX / 2);
  }
  return snuffed;
}

/** Trace every sunbeam; critters standing in a beam block it (and are lit by it), and so does the Gloom. */
export function traceBeams(state: GameState): number[][] {
  const { map } = state;
  const occupied = new Set<number>();
  for (const p of state.players.values()) occupied.add(p.y * map.w + p.x);
  if (state.gloom) for (const i of gloomFootprint(map.w, state.gloom.x, state.gloom.y)) occupied.add(i);
  return map.emitters.map((e) =>
    traceBeam(
      map.w,
      map.h,
      (x, y) => beamCellOf(tileAt(map, x, y)),
      e,
      (i) => state.mirrors.get(i),
      (i) => occupied.has(i),
    ),
  );
}

/** Recompute light; lit tiles become explored, and lit traps become visible to the party. */
function updateLight(state: GameState): void {
  const { map } = state;
  state.beams = traceBeams(state);
  state.light = computeLight(map.w, map.h, (x, y) => tileAt(map, x, y), lightSources(state), state.beams, BEAM_STRENGTH);
  const { level } = state.light;
  for (let i = 0; i < level.length; i++) {
    if (!level[i]) continue;
    if (!state.explored[i]) {
      state.explored[i] = 1;
      state.newlyExplored.push(i);
    }
    if (state.traps.has(i)) reveal(state, i);
  }
}

function reveal(state: GameState, i: number): void {
  if (state.revealedTraps.has(i)) return;
  state.revealedTraps.add(i);
  state.newlyRevealed.push(i);
}

export const heartIndex = (state: GameState, h: { x: number; y: number }): number => h.y * state.map.w + h.x;

/**
 * Where a tunnel dug from (x, y) in `dir` would go: from dirt ground, under 1–3 tiles of wall or gate,
 * up into dirt ground on the other side. Null if you're on paved stone, there's no wall, it's too
 * thick, or the far side isn't dirt.
 */
export function planTunnel(state: GameState, x: number, y: number, dir: 'n' | 's' | 'e' | 'w'): { a: number; b: number } | null {
  const [dx, dy] = DIRS[dir];
  const { map } = state;
  // You dig down from dirt ground, under 1–3 tiles of wall (or gate), and up into dirt ground.
  if (!isDiggableGround(tileAt(map, x, y))) return null;
  let n = 1;
  while (n <= MAX_TUNNEL_SOIL && canTunnelUnder(tileAt(map, x + dx * n, y + dy * n))) n++;
  if (n === 1) return null; // no wall next to you
  const ox = x + dx * n;
  const oy = y + dy * n;
  if (!isDiggableGround(tileAt(map, ox, oy))) return null;
  const a = y * map.w + x;
  const b = oy * map.w + ox;
  // One tunnel per spot: don't dig where a tunnel already starts or ends.
  if (state.tunnels.some((t) => t.a === a || t.b === a || t.a === b || t.b === b)) return null;
  return { a, b };
}

/**
 * Can this critter dig in `dir` right now? The server answers this before the game asks the player to
 * spend a brace, so the "Dig here?" prompt never offers a dig that would fail.
 */
export function digVerdict(state: GameState, playerId: string, dir: 'n' | 's' | 'e' | 'w'): { ok: boolean; reason: string } {
  const p = state.players.get(playerId);
  if (!p) return { ok: false, reason: "Can't dig here" };
  const { map } = state;
  const here = p.y * map.w + p.x;
  if (state.tunnels.some((t) => t.a === here || t.b === here)) return { ok: false, reason: 'Press Q to burrow through' };
  if (p.braces <= 0) return { ok: false, reason: 'No burrow braces left' };
  if (!isDiggableGround(tileAt(map, p.x, p.y))) return { ok: false, reason: 'Paved stone: too hard to dig' };
  const [dx, dy] = DIRS[dir];
  let n = 1;
  while (n <= MAX_TUNNEL_SOIL && canTunnelUnder(tileAt(map, p.x + dx * n, p.y + dy * n))) n++;
  if (n === 1) return { ok: false, reason: "Can't dig here" };
  const out = tileAt(map, p.x + dx * n, p.y + dy * n);
  if (canTunnelUnder(out)) return { ok: false, reason: 'Too thick to dig under' };
  if (!isDiggableGround(out)) return { ok: false, reason: "Can't dig here" };
  if (!planTunnel(state, p.x, p.y, dir)) return { ok: false, reason: 'Already a tunnel here' };
  return { ok: true, reason: '' };
}

/** Tunnels as [endA, endB, ownerId] triples. */
export function packTunnels(state: GameState): [number, number, string][] {
  return state.tunnels.map((t) => [t.a, t.b, t.owner]);
}

/** True during a boss introduction (nobody can act). */
export const inIntro = (state: GameState): boolean => state.tick < state.introUntil;

/** Torches as a flat [index, lit, ...] list. */
export function packTorches(state: GameState): number[] {
  const out: number[] = [];
  for (const [i, on] of state.torches) out.push(i, on ? 1 : 0);
  return out;
}

/** The Gloom for the wire: [x, y, pinned, dx, dy, restless, touching], or null. */
export function packGloom(state: GameState): number[] | null {
  const g = state.gloom;
  return g ? [g.x, g.y, g.pinned ? 1 : 0, g.dx, g.dy, g.restless, g.touching ? 1 : 0] : null;
}

/** Mirrors as a flat [index, orientation, ...] list. */
export function packMirrors(state: GameState): number[] {
  const out: number[] = [];
  for (const [i, o] of state.mirrors) out.push(i, o);
  return out;
}

/** Emitters as a flat [index, dx, dy, ...] list. */
export function packEmitters(state: GameState): number[] {
  return state.map.emitters.flatMap((e) => [e.y * state.map.w + e.x, e.dx, e.dy]);
}

/** Explored tiles as a flat [index, type, index, type, ...] list. */
export function packTiles(state: GameState, indices: Iterable<number>): number[] {
  const out: number[] = [];
  for (const i of indices) out.push(i, state.map.tiles[i]!);
  return out;
}

export function allExplored(state: GameState): number[] {
  const idx: number[] = [];
  for (let i = 0; i < state.explored.length; i++) if (state.explored[i]) idx.push(i);
  return idx;
}

