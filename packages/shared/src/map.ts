import { createRng, hashSeed, type Rng } from './rng';

export const Tile = {
  Wall: 0,
  Floor: 1,
  StairsDown: 2,
  /** Walkable floor lit from above. */
  Sunshaft: 3,
  /** A pedestal you can't stand on; doesn't block light. */
  Heartstone: 4,
} as const;
export type TileType = (typeof Tile)[keyof typeof Tile];

// Puzzle floors are smaller than the old dungeon floors so a lantern's oil can cover one.
export const MAP_W = 56;
export const MAP_H = 36;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  rooms: Rect[];
  entrance: Point;
  stairs: Point;
  sunshafts: Point[];
  hearts: Point[];
  /** Hidden booby trap tile indices. Server-only: never sent until revealed. */
  traps: number[];
}

export const isWalkable = (t: number): boolean => t === Tile.Floor || t === Tile.StairsDown || t === Tile.Sunshaft;
export const blocksSight = (t: number): boolean => t === Tile.Wall;

export function tileAt(map: FloorMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return Tile.Wall;
  return map.tiles[y * map.w + x]!;
}

const MIN_LEAF = 10;
/** The way down is at least this many steps from the entrance. */
export const MIN_STAIRS_DISTANCE = 22;
const MAX_DEPTH = 5;

/** Rootcellar floor: BSP rooms joined by tunnels. Same seed + floor + heart count => same map. */
export function generateFloor(seed: number, floor = 1, heartCount = 1, w = MAP_W, h = MAP_H): FloorMap {
  const rng = createRng(hashSeed(seed, floor, heartCount));
  for (let attempt = 0; attempt < 50; attempt++) {
    const map = tryGenerate(rng, w, h);
    if (map && placeFeatures(rng, map, heartCount)) return map;
  }
  throw new Error(`could not generate floor for seed ${seed}`);
}

const TRAP_CHANCE_ROOM = 0.035;
const TRAP_CHANCE_CORRIDOR = 0.02;

/**
 * Sunshafts, Heartstones and hidden traps. Every floor starts in a sunshaft so the party can see.
 * Heartstones go on room tiles with floor all around, so they can never cut off a path.
 */
function placeFeatures(rng: Rng, map: FloorMap, heartCount: number): boolean {
  const { w, tiles } = map;
  const idx = (p: Point) => p.y * w + p.x;
  const roomOf = (p: Point) => map.rooms.find((r) => inside(r, p));
  const entranceRoom = roomOf(map.entrance)!;
  const stairsRoom = roomOf(map.stairs);
  const interior = (r: Rect): Point[] => {
    const out: Point[] = [];
    for (let y = r.y + 1; y < r.y + r.h - 1; y++)
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        let open = true;
        for (let dy = -1; dy <= 1 && open; dy++)
          for (let dx = -1; dx <= 1 && open; dx++) if (tiles[(y + dy) * w + x + dx] !== Tile.Floor) open = false;
        if (open) out.push({ x, y });
      }
    return out;
  };

  tiles[idx(map.entrance)] = Tile.Sunshaft;
  map.sunshafts.push(map.entrance);

  // Heartstones: rooms other than the entrance's, preferring ones without the stairs.
  const candidates = map.rooms.filter((r) => r !== entranceRoom && interior(r).length > 0);
  const preferred = candidates.filter((r) => r !== stairsRoom);
  const pool = [...shuffle(rng, preferred), ...candidates.filter((r) => r === stairsRoom)];
  if (pool.length < heartCount) return false;
  for (const room of pool.slice(0, heartCount)) {
    const spots = interior(room);
    if (spots.length === 0) return false;
    const heart = rng.pick(spots);
    tiles[idx(heart)] = Tile.Heartstone;
    map.hearts.push(heart);
    // Half the time, a sunshaft near the Heartstone offers a cheaper solution (one lantern + sunlight).
    if (rng.chance(0.5)) {
      const near: Point[] = [];
      for (let y = room.y; y < room.y + room.h; y++)
        for (let x = room.x; x < room.x + room.w; x++) {
          const d = Math.max(Math.abs(x - heart.x), Math.abs(y - heart.y));
          if (d >= 2 && d <= 3 && tiles[y * w + x] === Tile.Floor) near.push({ x, y });
        }
      if (near.length) {
        const s = rng.pick(near);
        tiles[idx(s)] = Tile.Sunshaft;
        map.sunshafts.push(s);
      }
    }
  }

  // A couple of extra sunshafts elsewhere.
  for (const room of shuffle(rng, map.rooms.filter((r) => r !== entranceRoom)).slice(0, 2)) {
    const c = { x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) };
    if (tiles[idx(c)] === Tile.Floor) {
      tiles[idx(c)] = Tile.Sunshaft;
      map.sunshafts.push(c);
    }
  }

  // Hidden traps: never near the entrance, next to a Heartstone, or on special tiles.
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] !== Tile.Floor) continue;
    const p = { x: i % w, y: Math.floor(i / w) };
    if (Math.max(Math.abs(p.x - map.entrance.x), Math.abs(p.y - map.entrance.y)) <= 3) continue;
    if (map.hearts.some((hrt) => Math.max(Math.abs(p.x - hrt.x), Math.abs(p.y - hrt.y)) <= 1)) continue;
    if (rng.chance(roomOf(p) ? TRAP_CHANCE_ROOM : TRAP_CHANCE_CORRIDOR)) map.traps.push(i);
  }
  return true;
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function tryGenerate(rng: Rng, w: number, h: number): FloorMap | null {
  const tiles = new Uint8Array(w * h); // all walls
  const carve = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tiles[y * w + x] = Tile.Floor;
  };

  const build = (node: Rect, depth: number): Rect[] => {
    const canSplitV = node.w >= MIN_LEAF * 2;
    const canSplitH = node.h >= MIN_LEAF * 2;
    if (depth >= MAX_DEPTH || (!canSplitV && !canSplitH)) {
      // Leaf: carve one room inside it.
      const rw = rng.int(4, Math.min(14, node.w - 2));
      const rh = rng.int(4, Math.min(9, node.h - 2));
      const rx = node.x + rng.int(1, node.w - rw - 1);
      const ry = node.y + rng.int(1, node.h - rh - 1);
      for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) carve(x, y);
      return [{ x: rx, y: ry, w: rw, h: rh }];
    }
    let vertical: boolean;
    if (canSplitV && !canSplitH) vertical = true;
    else if (canSplitH && !canSplitV) vertical = false;
    else if (node.w > node.h * 1.25) vertical = true;
    else if (node.h > node.w * 1.25) vertical = false;
    else vertical = rng.chance(0.5);

    let a: Rect;
    let b: Rect;
    if (vertical) {
      const cut = rng.int(MIN_LEAF, node.w - MIN_LEAF);
      a = { x: node.x, y: node.y, w: cut, h: node.h };
      b = { x: node.x + cut, y: node.y, w: node.w - cut, h: node.h };
    } else {
      const cut = rng.int(MIN_LEAF, node.h - MIN_LEAF);
      a = { x: node.x, y: node.y, w: node.w, h: cut };
      b = { x: node.x, y: node.y + cut, w: node.w, h: node.h - cut };
    }
    const roomsA = build(a, depth + 1);
    const roomsB = build(b, depth + 1);

    // Join the closest pair of rooms across the split with an L-shaped tunnel.
    let best: [Rect, Rect] = [roomsA[0]!, roomsB[0]!];
    let bestD = Infinity;
    for (const ra of roomsA) {
      for (const rb of roomsB) {
        const d = Math.abs(center(ra).x - center(rb).x) + Math.abs(center(ra).y - center(rb).y);
        if (d < bestD) {
          bestD = d;
          best = [ra, rb];
        }
      }
    }
    const p = center(best[0]);
    const q = center(best[1]);
    if (rng.chance(0.5)) {
      for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) carve(x, p.y);
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) carve(q.x, y);
    } else {
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) carve(p.x, y);
      for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) carve(x, q.y);
    }
    return roomsA.concat(roomsB);
  };

  const rooms = build({ x: 0, y: 0, w, h }, 0);
  if (rooms.length < 4) return null;

  const entranceRoom = rng.pick(rooms);
  const entrance = center(entranceRoom);

  // Connectivity check + furthest tile by path distance.
  const dist = distanceMap(tiles, w, h, entrance);
  let floorCount = 0;
  let stairs = entrance;
  let far = -1;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === Tile.Wall) continue;
    floorCount++;
    const d = dist[i]!;
    if (d < 0) return null; // unreachable floor: regenerate
    const pt = { x: i % w, y: Math.floor(i / w) };
    if (d > far && rooms.some((r) => inside(r, pt))) {
      far = d;
      stairs = pt;
    }
  }
  if (floorCount < 200 || far < MIN_STAIRS_DISTANCE) return null;
  tiles[stairs.y * w + stairs.x] = Tile.StairsDown;

  return { w, h, tiles, rooms, entrance, stairs, sunshafts: [], hearts: [], traps: [] };
}

/** Breadth-first path distance from `from` over walkable tiles; -1 = unreachable. */
export function distanceMap(tiles: Uint8Array, w: number, h: number, from: Point): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const start = from.y * w + from.x;
  dist[start] = 0;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1 || !isWalkable(tiles[ni]!)) continue;
      dist[ni] = dist[i]! + 1;
      queue.push(ni);
    }
  }
  return dist;
}

/** The first `count` walkable tiles nearest to `from` (for spawning a party together). */
export function spawnPoints(map: FloorMap, from: Point, count: number): Point[] {
  const dist = distanceMap(map.tiles, map.w, map.h, from);
  const traps = new Set(map.traps);
  const cells: { i: number; d: number }[] = [];
  for (let i = 0; i < dist.length; i++) {
    const t = map.tiles[i];
    if (dist[i]! >= 0 && (t === Tile.Floor || t === Tile.Sunshaft) && !traps.has(i)) cells.push({ i, d: dist[i]! });
  }
  cells.sort((a, b) => a.d - b.d || a.i - b.i);
  return cells.slice(0, count).map(({ i }) => ({ x: i % map.w, y: Math.floor(i / map.w) }));
}

const center = (r: Rect): Point => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
