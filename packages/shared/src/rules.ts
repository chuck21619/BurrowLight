import { isWalkable, type FloorMap, tileAt } from './map';

/** Length of one server tick. One config value: try 80 and 150 in playtests. */
export const TICK_MS = 100;

export const ActionCost = {
  moveCardinal: 2,
  moveDiagonal: 3,
  wait: 1,
  blockedMove: 1,
  rotate: 2,
} as const;

export const BASE_SPEED = 100;

// ---- Light prototype tuning (all in ticks; 10 ticks = 1 second) ----
export const LANTERN_RADIUS = 4;
export const SUNSHAFT_RADIUS = 3;
/** A focused sunbeam is strong enough to charge a Heartstone on its own. */
export const BEAM_STRENGTH = 2;
/** Oil at the start of a run: 900 ticks = 90 seconds of lantern light (floors are small now). */
export const START_OIL = 900;
export const OIL_PER_TICK = 1;
/** Oil topped up when the party goes down a floor. */
export const OIL_PER_FLOOR = 450;
export const MAX_OIL = 1500;

// The Jitters: critters get jittery in the dark. A full meter means panic.
export const JITTERS_MAX = 600;
/** Per tick in the dark alone: full in 30 s. */
export const JITTERS_DARK = 2;
/** Per tick in the dark with a friend within 1 tile: full in 60 s. */
export const JITTERS_DARK_WITH_FRIEND = 1;
/** Per tick standing in any light: calms from full in 10 s. */
export const JITTERS_CALM = 6;
/** How long a booby trap knocks you out: 10 s, long enough that waking a friend matters. */
export const KO_TICKS = 100;
/**
 * Heartstones charge by the light reaching them each tick (any light counts; more light is
 * faster) and slowly fade when dark. One lantern fills one in 6 s, two lanterns or a sunbeam in 3 s.
 */
export const HEART_FULL = 60;
export const HEART_FADE = 1;
// ---- The Gloom (act 1 boss) ----
/** Floors 3, 6 and 9 end in a boss room. */
export const isBossFloor = (floor: number): boolean => floor % 3 === 0;
/** The Gloom moves one tile every this many ticks: slower than a walking critter (2). */
export const GLOOM_STEP = 3;
/** ...and half as fast when lantern light touches it. */
export const GLOOM_STEP_LIT = 6;
/** Restless (after a third of the Great Heartstone is charged) it speeds up. */
export const GLOOM_STEP_RESTLESS = 2;
export const GLOOM_STEP_RESTLESS_LIT = 4;
/** While pinned in a sunbeam it wriggles one tile every this many ticks: 4 s, then 3 s, then 2 s. */
export const GLOOM_WRIGGLE = [40, 30, 20] as const;
/**
 * While free, the Gloom drains the Great Heartstone through its tether, faster the closer it is:
 * 3 per tick when touching it, down to 0.25 per tick at 12 or more tiles away.
 */
export const GLOOM_DRAIN_NEAR = 3;
export const GLOOM_DRAIN_FAR = 0.25;
export const GLOOM_DRAIN_RANGE = 12;
export const gloomDrain = (distance: number): number =>
  GLOOM_DRAIN_FAR + (GLOOM_DRAIN_NEAR - GLOOM_DRAIN_FAR) * (1 - Math.min(distance, GLOOM_DRAIN_RANGE) / GLOOM_DRAIN_RANGE);
/** A critter it touches can't be touched again for this long. */
export const GLOOM_TOUCH_COOLDOWN = 20;
/** The Great Heartstone needs four times a normal one: 12 s of two lanterns while the Gloom is pinned. */
export const GREAT_HEART_FULL = 240;

/** About one Heartstone per two players. */
export const heartsForParty = (players: number): number => Math.max(1, Math.ceil(players / 2));
/** Real actions a player may have waiting on the server at once. */
export const MAX_QUEUED_INTENTS = 2;
export const MAX_PLAYERS = 8;

export const DIRS = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, -1],
  nw: [-1, -1],
  se: [1, 1],
  sw: [-1, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type Dir = keyof typeof DIRS;
export const isDir = (d: unknown): d is Dir => typeof d === 'string' && Object.hasOwn(DIRS, d);

/** `rotate` turns the mirror you're standing on. */
export type Action = { kind: 'move'; dir: Dir } | { kind: 'wait' } | { kind: 'rotate' };

export function isAction(a: unknown): a is Action {
  if (typeof a !== 'object' || a === null) return false;
  const o = a as { kind?: unknown; dir?: unknown };
  return o.kind === 'wait' || o.kind === 'rotate' || (o.kind === 'move' && isDir(o.dir));
}

/** cost = base x 100 / speed, rounded up, minimum 1 tick. */
export const scaledCost = (base: number, speed = BASE_SPEED): number => Math.max(1, Math.ceil((base * BASE_SPEED) / speed));

export const isDiagonal = (dir: Dir): boolean => dir.length === 2;

export function actionCost(action: Action, speed = BASE_SPEED): number {
  if (action.kind === 'wait') return scaledCost(ActionCost.wait, speed);
  if (action.kind === 'rotate') return scaledCost(ActionCost.rotate, speed);
  return scaledCost(isDiagonal(action.dir) ? ActionCost.moveDiagonal : ActionCost.moveCardinal, speed);
}

export type MoveCheck = 'ok' | 'wall' | 'occupied';

/**
 * Can something at (x, y) step in `dir`? Diagonals may not cut a wall corner.
 * `tile` lets the client pass its partial knowledge of the map (unknown tiles count as walls).
 */
export function checkMove(
  tile: (x: number, y: number) => number,
  x: number,
  y: number,
  dir: Dir,
  occupied: (x: number, y: number) => boolean,
): MoveCheck {
  const [dx, dy] = DIRS[dir];
  const nx = x + dx;
  const ny = y + dy;
  if (!isWalkable(tile(nx, ny))) return 'wall';
  if (dx !== 0 && dy !== 0 && (!isWalkable(tile(x + dx, y)) || !isWalkable(tile(x, y + dy)))) return 'wall';
  if (occupied(nx, ny)) return 'occupied';
  return 'ok';
}

/**
 * Where a move in `dir` actually goes. A blocked diagonal slides along whichever
 * straight direction is open (horizontal first), so walking diagonally into a wall
 * keeps you moving instead of stopping you. Returns null if nothing is open.
 */
export function resolveMove(
  tile: (x: number, y: number) => number,
  x: number,
  y: number,
  dir: Dir,
  occupied: (x: number, y: number) => boolean,
): Dir | null {
  if (checkMove(tile, x, y, dir, occupied) === 'ok') return dir;
  if (!isDiagonal(dir)) return null;
  const [dx, dy] = DIRS[dir];
  const horizontal: Dir = dx > 0 ? 'e' : 'w';
  const vertical: Dir = dy > 0 ? 's' : 'n';
  if (checkMove(tile, x, y, horizontal, occupied) === 'ok') return horizontal;
  if (checkMove(tile, x, y, vertical, occupied) === 'ok') return vertical;
  return null;
}

export const mapTile =(map: FloorMap) => (x: number, y: number) => tileAt(map, x, y);
