import { traceBeam, type MirrorOrient } from './beam';
import { computeLight, type LightMap, type LightSource } from './light';
import { beamCellOf, generateFloor, spawnPoints, tileAt, type FloorMap } from './map';
import {
  BASE_SPEED,
  DIRS,
  HEART_CHARGE_TICKS,
  HEART_NEED,
  KO_TICKS,
  LANTERN_RADIUS,
  MAX_OIL,
  MAX_QUEUED_INTENTS,
  OIL_PER_FLOOR,
  OIL_PER_TICK,
  START_OIL,
  SUNSHAFT_RADIUS,
  BEAM_STRENGTH,
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
}

export interface HeartState {
  x: number;
  y: number;
  charge: number;
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
}

export interface NewPlayer {
  id: string;
  name: string;
  color: number;
}

export function createGame(seed: number, players: NewPlayer[]): GameState {
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
    });
  });
  enterFloor(state, 1);
  return state;
}

/** Build floor `n` and put the party at its entrance. */
function enterFloor(state: GameState, n: number): void {
  const map = generateFloor(hashSeed(state.seed), n, heartsForParty(state.players.size));
  state.floor = n;
  state.map = map;
  state.explored = new Uint8Array(map.w * map.h);
  state.newlyExplored = [];
  state.traps = new Set(map.traps);
  state.revealedTraps = new Set();
  state.newlyRevealed = [];
  state.hearts = map.hearts.map((h) => ({ x: h.x, y: h.y, charge: 0 }));
  state.exitOpen = false;
  state.mirrors = new Map(map.mirrors.map((m) => [m.y * map.w + m.x, m.orient]));
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
  if (state.tick < p.koUntil || p.panic || state.runOver) {
    p.lastAck = seq; // seeing stars or panicking: input is dropped, not saved for later
    return;
  }
  const real = p.queue.filter((q) => q.action !== null).length;
  p.queue.push({ seq, action: real >= MAX_QUEUED_INTENTS ? null : action });
}

/** Light or douse a lantern. Can't light it without oil. Applies straight away. */
export function setLantern(state: GameState, playerId: string, on: boolean): void {
  const p = state.players.get(playerId);
  if (p && !p.panic && !state.runOver) p.lit = on && p.oil > 0;
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
      // Snap! Stars circle your head; your lantern keeps burning while you're out.
      p.koUntil = state.tick + KO_TICKS;
      p.readyAt = p.koUntil;
      clearQueue(p);
      reveal(state, here);
    }
  }

  for (const p of order) {
    if (!p.lit) continue;
    p.oil = Math.max(0, p.oil - OIL_PER_TICK);
    if (p.oil === 0) p.lit = false;
  }

  updateLight(state);
  updateJitters(state, order);

  for (const h of state.hearts) {
    const lit = state.light.level[h.y * state.map.w + h.x]! >= HEART_NEED;
    h.charge = lit ? Math.min(HEART_CHARGE_TICKS, h.charge + 1) : Math.max(0, h.charge - 1);
  }
  if (!state.exitOpen && state.hearts.every((h) => h.charge >= HEART_CHARGE_TICKS)) state.exitOpen = true;

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
  return out;
}

/** Trace every sunbeam; critters standing in a beam block it (and are lit by it). */
export function traceBeams(state: GameState): number[][] {
  const { map } = state;
  const occupied = new Set<number>();
  for (const p of state.players.values()) occupied.add(p.y * map.w + p.x);
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

