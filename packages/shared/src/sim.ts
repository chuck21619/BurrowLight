import { traceBeamSplit, type MirrorOrient } from './beam';
import {
  BRIGHT_WICK_RADIUS,
  QUICK_PAWS_DIG_TICKS,
  SHARE_FLAME_OIL,
  SOOTHE_RADIUS,
  TRAP_SENSE_RADIUS,
  learnProblem,
  type TalentId,
} from './talents';
import { computeLight, type LightMap, type LightSource } from './light';
import {
  MAX_TUNNEL_SOIL,
  Tile,
  beamCellOf,
  canTunnelUnder,
  isDiggableGround,
  generateBossFloor,
  generateMothFloor,
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
  GEM_FULL,
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
  FINAL_FLOOR,
  TICK_MS,
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
  actOf,
  GLOWCAP_RADIUS,
  GLOWCAP_TICKS,
  MOTH_STEP,
  MOTH_STEP_RESTLESS,
  MOTH_WAKE_TICKS,
  MOTH_LAND_TICKS,
  MOTH_BORED_TICKS,
  MOTH_DRAIN,
  MOTH_GLOWCAP_BRIGHTNESS,
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
  /** Talents learned this run. */
  talents: Set<TalentId>;
  /** Unspent talent points (one per floor the party goes down). */
  points: number;
  /** Mirror Pack: carrying the mirror (rather than having set it down). */
  mirror: boolean;
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
  /** The party beat floor 9's boss and went down its ladder: the Hearthlight is restored. */
  runWon: boolean;
  /** Running totals for the end-of-run summary. */
  stats: RunStats;
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
  /** Mirrors set down with Mirror Pack: tile index -> who placed it. */
  placedMirrors: Map<number, string>;
  /** Pen doors and what opens them. */
  locks: LockState[];
  /** Glowcap tile index -> ticks it stays lit (0 = dark). */
  glowcaps: Map<number, number>;
  /** The act 2 boss, until the Great Heartstone is full. */
  moth: MothState | null;
}

/** The Mothmother: a big moth (2×2, (x, y) its top-left tile) that flies to lights and lands on them. */
export interface MothState {
  x: number;
  y: number;
  nextStepAt: number;
  /** Sitting on a light until this tick (0 = flying). */
  landedUntil: number;
  /** What she's after: 'stone', 'cap:<index>', or a critter's id. */
  target: string | null;
  /** Lights she's bored of, until this tick. */
  bored: Map<string, number>;
  /** 0, 1 or 2: faster as the Great Heartstone fills. */
  restless: number;
  /** Facing (-1 left, 1 right), for drawing. */
  face: number;
}

export interface LockState {
  door: number;
  /** Pressure plate tile index, or -1. */
  plate: number;
  /** Sun gem tile index, or -1. */
  gem: number;
  /** Ticks of sunbeam the gem has soaked up. */
  charge: number;
  open: boolean;
  /** The gem filled: the door stays open for good. */
  solved: boolean;
}

export interface RunStats {
  floorsCleared: number;
  heartstones: number;
  trapsSprung: number;
  panics: number;
  tunnels: number;
  /** Ticks of lantern oil burned by the whole party. */
  oilBurned: number;
  /** Times the Gloom was pinned in a sunbeam. */
  pins: number;
  startTick: number;
}

/** The end-of-run summary sent to everyone. */
export interface RunSummary {
  won: boolean;
  floorReached: number;
  floorsCleared: number;
  /** Seconds the run took. */
  seconds: number;
  heartstones: number;
  trapsSprung: number;
  panics: number;
  tunnels: number;
  /** Seconds of lantern light burned by the party. */
  oilSeconds: number;
  pins: number;
}

export function runSummary(state: GameState): RunSummary {
  const s = state.stats;
  return {
    won: state.runWon,
    floorReached: state.floor,
    floorsCleared: s.floorsCleared,
    seconds: Math.round(((state.tick - s.startTick) * TICK_MS) / 1000),
    heartstones: s.heartstones,
    trapsSprung: s.trapsSprung,
    panics: s.panics,
    tunnels: s.tunnels,
    oilSeconds: Math.round(s.oilBurned / 10),
    pins: s.pins,
  };
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
    runWon: false,
    stats: { floorsCleared: 0, heartstones: 0, trapsSprung: 0, panics: 0, tunnels: 0, oilBurned: 0, pins: 0, startTick: 0 },
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
      talents: new Set(),
      points: 0,
      mirror: false,
    });
  });
  // Starting deeper (a testing option) comes with the points you'd have earned on the way down.
  for (const p of state.players.values()) p.points = startFloor - 1;
  enterFloor(state, startFloor);
  return state;
}

/** Build floor `n` and put the party at its entrance. */
function enterFloor(state: GameState, n: number): void {
  const map = isBossFloor(n)
    ? actOf(n) === 2
      ? generateMothFloor(hashSeed(state.seed), n)
      : generateBossFloor(hashSeed(state.seed), n)
    : generateFloor(hashSeed(state.seed), n, heartsForParty(state.players.size));
  state.floor = n;
  state.map = map;
  state.explored = new Uint8Array(map.w * map.h);
  state.newlyExplored = [];
  state.traps = new Set(map.traps);
  state.revealedTraps = new Set();
  state.newlyRevealed = [];
  const great = Boolean(map.gloomStart || map.mothStart);
  state.hearts = map.hearts.map((h) => ({ x: h.x, y: h.y, charge: 0, max: great ? GREAT_HEART_FULL : HEART_FULL }));
  state.glowcaps = new Map(map.glowcaps.map((c) => [c.y * map.w + c.x, 0]));
  state.moth = map.mothStart
    ? { ...map.mothStart, nextStepAt: state.tick + MOTH_WAKE_TICKS, landedUntil: 0, target: null, bored: new Map(), restless: 0, face: -1 }
    : null;
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
  state.placedMirrors = new Map();
  const at = (p: { x: number; y: number } | undefined) => (p ? p.y * map.w + p.x : -1);
  state.locks = map.locks.map((l) => ({ door: at(l.door), plate: at(l.plate), gem: at(l.gem), charge: 0, open: false, solved: false }));
  for (const p of state.players.values()) {
    p.digging = null;
    p.braces = BURROW_BRACES_PER_FLOOR + (p.talents.has('deepPockets') ? 1 : 0);
    p.mirror = p.talents.has('mirrorPack'); // a placed mirror stays behind; you start each floor with it
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
  if (state.runOver || state.runWon) return;
  state.tick++;
  state.newlyExplored = [];
  state.newlyRevealed = [];
  state.descended = false;
  const order = [...state.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  const tile = mapTile(state.map);

  for (const p of order) {
    // A finished dig uses up a burrow brace, opens a permanent tunnel, and the digger pops out the far end.
    if (p.digging && state.tick >= p.digging.until) {
      state.tunnels.push({ a: p.digging.a, b: p.digging.b, owner: p.id });
      state.stats.tunnels++;
      p.braces = Math.max(0, p.braces - 1);
      p.x = p.digging.b % state.map.w;
      p.y = Math.floor(p.digging.b / state.map.w);
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
        // Bumping into something in the dark lets you feel what it is: reveal that tile to the party.
        const bx = p.x + DIRS[action.dir][0];
        const by = p.y + DIRS[action.dir][1];
        const bi = by * state.map.w + bx;
        if (bx >= 0 && by >= 0 && bx < state.map.w && by < state.map.h && !state.explored[bi]) {
          state.explored[bi] = 1;
          state.newlyExplored.push(bi);
        }
      }
    } else if (action.kind === 'dig') {
      const plan = p.braces > 0 ? planTunnel(state, p.x, p.y, action.dir, p.talents.has('stonebreaker')) : null;
      if (plan) {
        const digTime = p.talents.has('quickPaws') ? QUICK_PAWS_DIG_TICKS : actionCost(action, p.speed);
        p.digging = { until: state.tick + digTime, ...plan };
        cost = digTime;
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
    } else if (action.kind === 'interact') {
      interact(state, p);
      cost = actionCost(action, p.speed);
    } else if (action.kind === 'mirror') {
      useMirrorPack(state, p);
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
      state.stats.trapsSprung++;
      p.lit = false;
      p.readyAt = p.koUntil;
      clearQueue(p);
      reveal(state, here);
    }
  }

  // Carrying a flame over a torch lights it; over a glowcap, lights it (again) for a while.
  for (const p of order) {
    const here = p.y * state.map.w + p.x;
    if (p.lit && state.torches.get(here) === false) state.torches.set(here, true);
    if (p.lit && state.glowcaps.has(here)) state.glowcaps.set(here, GLOWCAP_TICKS);
  }
  for (const [i, left] of state.glowcaps) if (left > 0) state.glowcaps.set(i, left - 1);

  if (inIntro(state)) {
    // The boss introduction: everyone watches the Gloom drift to a torch and eat it.
    updateLight(state);
    const moved = updateGloom(state);
    if (gloomTouches(state, order) || moved) updateLight(state);
    if (state.torches.get(state.introTorch) === false) state.introUntil = Math.min(state.introUntil, state.tick + BOSS_INTRO_PAUSE);
    return;
  }

  updateLocks(state, order);

  for (const p of order) {
    if (!p.lit) continue;
    if (p.talents.has('thriftyWick') && state.tick % 2 === 1) continue; // half the burn
    p.oil = Math.max(0, p.oil - OIL_PER_TICK);
    state.stats.oilBurned += OIL_PER_TICK;
    if (p.oil === 0) p.lit = false;
  }

  updateLight(state);
  const gloomMoved = updateGloom(state);
  // A snuffed lantern or eaten torch stops giving light this very tick.
  if (gloomTouches(state, order) || gloomMoved) updateLight(state);
  if (updateMoth(state, order)) updateLight(state);
  updateJitters(state, order);

  const g = state.gloom;
  for (const h of state.hearts) {
    const light = state.light.level[h.y * state.map.w + h.x]!;
    if (g && !g.pinned) {
      // The tether siphons off every bit of light poured in, and drains the stone: fast up close, slow far away.
      h.charge = Math.max(0, h.charge - gloomDrain(g.distance));
    } else if (state.moth && state.moth.target === 'stone' && state.moth.landedUntil > state.tick) {
      // The Mothmother sitting on the Great Heartstone: her wings cover it and she sips its light.
      h.charge = Math.max(0, h.charge - MOTH_DRAIN);
    } else {
      h.charge = light > 0 ? Math.min(h.max, h.charge + light) : Math.max(0, h.charge - HEART_FADE);
    }
  }
  if (!state.exitOpen && state.hearts.every((h) => h.charge >= h.max)) {
    state.exitOpen = true;
    state.stats.heartstones += state.hearts.length;
    state.gloom = null; // sun-soaked and content, it puffs away
    state.moth = null; // dazzled, she flutters off up the shaft
  }

  if (state.exitOpen) {
    const present = order.filter((p) => opts.isPresent?.(p.id) ?? true);
    const s = state.map.stairs;
    if (present.length > 0 && present.every((p) => p.x === s.x && p.y === s.y)) {
      state.stats.floorsCleared++;
      if (state.floor >= FINAL_FLOOR) {
        state.runWon = true; // the Hearthlight is restored
        return;
      }
      for (const p of order) {
        p.oil = Math.min(MAX_OIL, p.oil + OIL_PER_FLOOR);
        p.points++; // a talent point for every floor the party goes down
      }
      enterFloor(state, state.floor + 1);
      state.descended = true;
    }
  }
}

/**
 * Pen doors: a pressure plate holds its door open while a critter (or a set-down mirror) is on it;
 * a sun gem soaks up sunbeam light (fading when the beam leaves) and, once full, opens its door for
 * good. A door never shuts on a critter standing in the doorway.
 */
function updateLocks(state: GameState, order: PlayerState[]): void {
  const { map } = state;
  const ends = new Set(state.beams.map((b) => b[b.length - 1]));
  const on = (i: number) => order.some((p) => p.y * map.w + p.x === i);
  for (const l of state.locks) {
    if (l.gem >= 0 && !l.solved) {
      l.charge = ends.has(l.gem) ? Math.min(GEM_FULL, l.charge + 1) : Math.max(0, l.charge - 1);
      if (l.charge >= GEM_FULL) l.solved = true;
    }
    const pressed = l.plate >= 0 && (on(l.plate) || state.mirrors.has(l.plate));
    const want = l.solved || pressed || (l.open && on(l.door));
    if (want !== l.open) {
      l.open = want;
      map.tiles[l.door] = want ? Tile.DoorOpen : Tile.Door;
    }
  }
}

/** Locks for the wire: flat [door, plate, gem, charge 0–100, open, ...]. */
export function packLocks(state: GameState): number[] {
  return state.locks.flatMap((l) => [l.door, l.plate, l.gem, Math.round((l.charge / GEM_FULL) * 100), l.open ? 1 : 0]);
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
      const near = (q: PlayerState, r: number) => q !== p && Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) <= r;
      // A friend right next to you, or a Soothe friend within 2 tiles, halves the Jitters.
      const friend = order.some((q) => near(q, 1) || (q.talents.has('soothe') && near(q, SOOTHE_RADIUS)));
      p.jitters = Math.min(JITTERS_MAX, p.jitters + (friend ? JITTERS_DARK_WITH_FRIEND : JITTERS_DARK));
    }
    if (!p.panic && p.jitters >= JITTERS_MAX) {
      p.panic = true;
      state.stats.panics++;
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
  for (const p of state.players.values())
    if (p.lit) out.push({ x: p.x, y: p.y, radius: p.talents.has('brightWick') ? BRIGHT_WICK_RADIUS : LANTERN_RADIUS, strength: 1 });
  for (const s of state.map.sunshafts) out.push({ x: s.x, y: s.y, radius: SUNSHAFT_RADIUS, strength: 1 });
  for (const [i, on] of state.torches) if (on) out.push({ x: i % state.map.w, y: Math.floor(i / state.map.w), radius: TORCH_RADIUS, strength: 1 });
  for (const [i, left] of state.glowcaps) if (left > 0) out.push({ x: i % state.map.w, y: Math.floor(i / state.map.w), radius: GLOWCAP_RADIUS, strength: 1 });
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
      state.stats.pins++;
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

/**
 * The Mothmother flies (over walls) toward the most appealing light: brightness against distance.
 * Lit lanterns (huddled ones count more), lit glowcaps, and the Great Heartstone, which pulls harder
 * as it fills. When her wings cover it she lands: a lantern goes out (with a burst of Jitters), a
 * glowcap goes out, and the stone is drained while she sits on it. After a landing she's bored of
 * that light for a while. Returns true if any light changed.
 */
function updateMoth(state: GameState, order: PlayerState[]): boolean {
  const m = state.moth;
  const heart = state.hearts[0];
  if (!m || !heart) return false;
  const { map } = state;
  const w = map.w;
  m.restless = heart.charge >= (heart.max * 2) / 3 ? 2 : heart.charge >= heart.max / 3 ? 1 : 0;
  const foot = new Set(gloomFootprint(w, m.x, m.y));
  let changed = false;

  if (m.landedUntil > state.tick) {
    // Sitting: anything lit under her wings goes out.
    for (const p of order) {
      if (!foot.has(p.y * w + p.x) || !p.lit || state.tick - p.gloomTouchAt < GLOOM_TOUCH_COOLDOWN) continue;
      p.gloomTouchAt = state.tick;
      p.lit = false;
      p.jitters = Math.min(JITTERS_MAX, p.jitters + JITTERS_MAX / 2);
      changed = true;
    }
    for (const i of foot) if ((state.glowcaps.get(i) ?? 0) > 0) {
      state.glowcaps.set(i, 0);
      changed = true;
    }
    return changed;
  }
  if (m.landedUntil > 0) {
    // Just took off: bored of that light for a while.
    if (m.target) m.bored.set(m.target, state.tick + MOTH_BORED_TICKS);
    m.landedUntil = 0;
    m.target = null;
  }
  if (state.tick < m.nextStepAt) return false;
  m.nextStepAt = state.tick + (m.restless ? MOTH_STEP_RESTLESS : MOTH_STEP);

  // Pick the most appealing light.
  const cx = m.x + 0.5;
  const cy = m.y + 0.5;
  let best: { what: string; x: number; y: number } | null = null;
  let bestScore = -Infinity;
  const consider = (what: string, x: number, y: number, brightness: number) => {
    if ((m.bored.get(what) ?? 0) > state.tick) return;
    const score = brightness * GLOOM_BRIGHTNESS_WEIGHT - Math.max(Math.abs(x - cx), Math.abs(y - cy));
    if (score > bestScore) {
      bestScore = score;
      best = { what, x, y };
    }
  };
  consider('stone', heart.x, heart.y, GLOOM_STONE_BASE + GLOOM_STONE_FULL_BONUS * (heart.charge / heart.max));
  for (const [i, left] of state.glowcaps) if (left > 0) consider(`cap:${i}`, i % w, Math.floor(i / w), MOTH_GLOWCAP_BRIGHTNESS);
  const lit = order.filter((p) => p.lit);
  for (const p of lit) consider(p.id, p.x, p.y, lit.filter((q) => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) <= 1).length);
  const target = best as { what: string; x: number; y: number } | null;
  m.target = target?.what ?? null;
  if (!target) return false;

  // Landed once her wings cover it.
  if (foot.has(target.y * w + target.x)) {
    m.landedUntil = state.tick + MOTH_LAND_TICKS;
    return false;
  }
  // Flutter one tile toward it (straight over walls), staying inside the room's outer wall.
  const dx = Math.sign(target.x - cx);
  const dy = Math.sign(target.y - cy);
  if (dx) m.face = dx;
  m.x = Math.min(map.w - 3, Math.max(1, m.x + dx));
  m.y = Math.min(map.h - 3, Math.max(1, m.y + dy));
  return false;
}

/** The Mothmother for the wire: [x, y, landed, face, restless], or null. */
export function packMoth(state: GameState): number[] | null {
  const m = state.moth;
  return m ? [m.x, m.y, m.landedUntil > state.tick ? 1 : 0, m.face, m.restless] : null;
}

/** Glowcaps as a flat [index, ticksLeft, ...] list. */
export function packGlowcaps(state: GameState): number[] {
  const out: number[] = [];
  for (const [i, left] of state.glowcaps) out.push(i, left);
  return out;
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
  const prisms = new Set<number>();
  for (const p of state.players.values()) if (p.talents.has('prism')) prisms.add(p.y * map.w + p.x);
  return map.emitters.flatMap((e) =>
    traceBeamSplit(
      map.w,
      map.h,
      (x, y) => beamCellOf(tileAt(map, x, y)),
      e,
      (i) => state.mirrors.get(i),
      (i) => occupied.has(i),
      (i) => prisms.has(i),
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
  // Trap Sense: traps close by show up even in the dark.
  for (const p of state.players.values()) {
    if (!p.talents.has('trapSense')) continue;
    for (const t of state.traps)
      if (Math.max(Math.abs((t % map.w) - p.x), Math.abs(Math.floor(t / map.w) - p.y)) <= TRAP_SENSE_RADIUS) reveal(state, t);
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
export function planTunnel(
  state: GameState,
  x: number,
  y: number,
  dir: 'n' | 's' | 'e' | 'w',
  stonebreaker = false,
): { a: number; b: number } | null {
  const ground = (t: number) => isDiggableGround(t) || (stonebreaker && t === Tile.StoneFloor);
  const [dx, dy] = DIRS[dir];
  const { map } = state;
  // You dig down from dirt ground, under 1–3 tiles of wall (or gate), and up into dirt ground.
  if (!ground(tileAt(map, x, y))) return null;
  let n = 1;
  while (n <= MAX_TUNNEL_SOIL && canTunnelUnder(tileAt(map, x + dx * n, y + dy * n))) n++;
  if (n === 1) return null; // no wall next to you
  const ox = x + dx * n;
  const oy = y + dy * n;
  if (!ground(tileAt(map, ox, oy))) return null;
  const a = y * map.w + x;
  const b = oy * map.w + ox;
  // One tunnel per spot: don't dig where a tunnel already starts or ends.
  if (state.tunnels.some((t) => t.a === a || t.b === a || t.a === b || t.b === b)) return null;
  // Never on top of a trap, at either end.
  if (state.traps.has(a) || state.traps.has(b)) return null;
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
  const stone = p.talents.has('stonebreaker');
  const ground = (t: number) => isDiggableGround(t) || (stone && t === Tile.StoneFloor);
  if (!ground(tileAt(map, p.x, p.y))) return { ok: false, reason: 'Paved stone: too hard to dig' };
  const [dx, dy] = DIRS[dir];
  let n = 1;
  while (n <= MAX_TUNNEL_SOIL && canTunnelUnder(tileAt(map, p.x + dx * n, p.y + dy * n))) n++;
  if (n === 1) return { ok: false, reason: "Can't dig here" };
  const out = tileAt(map, p.x + dx * n, p.y + dy * n);
  if (canTunnelUnder(out)) return { ok: false, reason: 'Too thick to dig under' };
  if (!ground(out)) return { ok: false, reason: "Can't dig here" };
  const a = p.y * map.w + p.x;
  const b = (p.y + dy * n) * map.w + p.x + dx * n;
  if (state.tunnels.some((t) => t.a === a || t.b === a || t.a === b || t.b === b)) return { ok: false, reason: 'Already a tunnel here' };
  if (!planTunnel(state, p.x, p.y, dir, stone)) return { ok: false, reason: "Can't dig here" };
  return { ok: true, reason: '' };
}

/** Learn a talent, if the critter has a point and meets its requirement. Returns why not, or null. */
export function learnTalent(state: GameState, playerId: string, talent: TalentId): string | null {
  const p = state.players.get(playerId);
  if (!p) return 'No such critter';
  const problem = learnProblem(p.talents, p.points, talent);
  if (problem) return problem;
  p.talents.add(talent);
  p.points--;
  if (talent === 'deepPockets') p.braces++; // the extra brace counts on this floor too
  if (talent === 'mirrorPack') p.mirror = true;
  return null;
}

const near1 = (a: PlayerState, x: number, y: number) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= 1;

/**
 * E: turn the mirror you're standing on; otherwise use a talent on what's next to you, in this order:
 * wake a dazed friend (Mend), remove a trap you can see (Disarm), give a friend oil (Share the Flame).
 */
function interact(state: GameState, p: PlayerState): void {
  const { map } = state;
  const here = p.y * map.w + p.x;
  const m = state.mirrors.get(here);
  if (m !== undefined) {
    state.mirrors.set(here, (1 - m) as MirrorOrient);
    return;
  }
  const friends = [...state.players.values()].filter((q) => q !== p && near1(q, p.x, p.y));
  if (p.talents.has('mend')) {
    const dazed = friends.find((q) => q.koUntil > state.tick);
    if (dazed) {
      dazed.koUntil = state.tick;
      dazed.readyAt = state.tick;
      return;
    }
  }
  if (p.talents.has('disarm')) {
    const trap = [...state.revealedTraps].find((t) => state.traps.has(t) && near1(p, t % map.w, Math.floor(t / map.w)));
    if (trap !== undefined) {
      state.traps.delete(trap);
      state.revealedTraps.delete(trap);
      return;
    }
  }
  if (p.talents.has('shareFlame') && p.oil > 0) {
    const friend = friends.find((q) => q.oil < MAX_OIL);
    if (friend) {
      const amount = Math.min(SHARE_FLAME_OIL, p.oil, MAX_OIL - friend.oil);
      p.oil -= amount;
      friend.oil += amount;
      if (p.oil === 0) p.lit = false;
    }
  }
}

/** R: set your Mirror Pack mirror down on empty floor, or pick it back up from where you're standing. */
function useMirrorPack(state: GameState, p: PlayerState): void {
  if (!p.talents.has('mirrorPack')) return;
  const { map } = state;
  const here = p.y * map.w + p.x;
  if (!p.mirror) {
    if (state.placedMirrors.get(here) === p.id) {
      state.mirrors.delete(here);
      state.placedMirrors.delete(here);
      p.mirror = true;
    }
    return;
  }
  const t = tileAt(map, p.x, p.y);
  const empty =
    (t === Tile.Floor || t === Tile.StoneFloor || t === Tile.Plate) &&
    !state.mirrors.has(here) &&
    !state.torches.has(here) &&
    !state.tunnels.some((tn) => tn.a === here || tn.b === here);
  if (!empty) return;
  state.mirrors.set(here, 0);
  state.placedMirrors.set(here, p.id);
  p.mirror = false;
}

/** Talents, unspent points and Mirror Pack state for every critter: [id, talents, points, carryingMirror]. */
export function packParty(state: GameState): [string, TalentId[], number, 0 | 1][] {
  return [...state.players.values()].map((p) => [p.id, [...p.talents], p.points, p.mirror ? 1 : 0]);
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

