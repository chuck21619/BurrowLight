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

/** How many rooms a floor has: beginner floors are small, deeper floors grow to 5. */
export function roomCountFor(floor: number, rng: Rng): number {
  if (floor <= 1) return rng.int(1, 2);
  if (floor === 2) return rng.int(2, 3);
  if (floor === 3) return rng.int(2, 4);
  return rng.int(3, 5);
}

/**
 * A compact puzzle floor: 1–5 small rooms close together, joined by short tunnels.
 * Same seed + floor + heart count => same map.
 */
export function generateFloor(seed: number, floor = 1, heartCount = 1): FloorMap {
  const rng = createRng(hashSeed(seed, floor, heartCount));
  for (let attempt = 0; attempt < 100; attempt++) {
    const map = tryGenerate(rng, roomCountFor(floor, rng));
    if (map && placeFeatures(rng, map, heartCount)) return map;
  }
  throw new Error(`could not generate floor for seed ${seed}`);
}

const ROOM_GAP = 2; // walls between rooms, so a tunnel is at least 1 tile long
const MAX_REACH = 6; // each new room sits within this many tiles of an existing one

function tryGenerate(rng: Rng, roomCount: number): FloorMap | null {
  // Lay rooms out on a generous canvas, then crop to what's used.
  const cw = 14 + roomCount * 12;
  const ch = 12 + roomCount * 7;
  const rooms: Rect[] = [];
  for (let k = 0; k < roomCount; k++) {
    let placed = false;
    for (let tries = 0; tries < 300 && !placed; tries++) {
      const r = { w: rng.int(6, 11), h: rng.int(5, 8), x: 0, y: 0 };
      r.x = rng.int(1, cw - r.w - 1);
      r.y = rng.int(1, ch - r.h - 1);
      if (rooms.some((o) => gapBetween(o, r) < ROOM_GAP)) continue;
      if (rooms.length && !rooms.some((o) => gapBetween(o, r) <= MAX_REACH)) continue;
      rooms.push(r);
      placed = true;
    }
    if (!placed) return null;
  }

  const tiles = new Uint8Array(cw * ch);
  const carve = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < cw - 1 && y < ch - 1) tiles[y * cw + x] = Tile.Floor;
  };
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y);

  // Join rooms with a minimum spanning tree of short L-shaped tunnels...
  const joined = [0];
  const links: [number, number][] = [];
  while (joined.length < rooms.length) {
    let best: [number, number] = [0, 0];
    let bestD = Infinity;
    for (const a of joined)
      for (let b = 0; b < rooms.length; b++) {
        if (joined.includes(b)) continue;
        const d = dist(center(rooms[a]!), center(rooms[b]!));
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
    joined.push(best[1]);
    links.push(best);
  }
  // ...plus, on bigger floors, one extra loop so there's more than one way around.
  if (rooms.length >= 4 && rng.chance(0.6)) {
    const a = rng.int(0, rooms.length - 1);
    const b = rng.int(0, rooms.length - 1);
    if (a !== b && !links.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) links.push([a, b]);
  }
  for (const [a, b] of links) {
    const p = center(rooms[a]!);
    const q = center(rooms[b]!);
    if (rng.chance(0.5)) {
      for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) carve(x, p.y);
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) carve(q.x, y);
    } else {
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) carve(p.x, y);
      for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) carve(x, q.y);
    }
  }

  // Crop to the used area plus a 1-tile wall border.
  let minX = cw;
  let minY = ch;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === Tile.Wall) continue;
    const x = i % cw;
    const y = (i - x) / cw;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const ox = minX - 1;
  const oy = minY - 1;
  const w = maxX - minX + 3;
  const h = maxY - minY + 3;
  const cropped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cropped[y * w + x] = tiles[(y + oy) * cw + x + ox]!;
  const shifted = rooms.map((r) => ({ ...r, x: r.x - ox, y: r.y - oy }));

  const entrance = center(shifted[0]!);
  const dmap = distanceMap(cropped, w, h, entrance);
  let stairs = entrance;
  let far = -1;
  for (let i = 0; i < cropped.length; i++) {
    if (cropped[i] === Tile.Wall) continue;
    if (dmap[i]! < 0) return null; // unreachable floor: try again
    const pt = { x: i % w, y: Math.floor(i / w) };
    if (dmap[i]! > far && shifted.some((r) => inside(r, pt))) {
      far = dmap[i]!;
      stairs = pt;
    }
  }
  if (far < 4) return null;
  cropped[stairs.y * w + stairs.x] = Tile.StairsDown;
  return { w, h, tiles: cropped, rooms: shifted, entrance, stairs, sunshafts: [], hearts: [], traps: [] };
}

const TRAP_CHANCE_ROOM = 0.04;
const TRAP_CHANCE_CORRIDOR = 0.03;
/** Nothing dangerous or important this close to where the party starts. */
const SAFE_START_RADIUS = 2;

/**
 * Sunshafts, Heartstones and hidden traps. Every floor starts in a sunshaft so the party can see.
 * Heartstones go on room tiles with floor all around, so they can never cut off a path.
 */
function placeFeatures(rng: Rng, map: FloorMap, heartCount: number): boolean {
  const { w, tiles } = map;
  const idx = (p: Point) => p.y * w + p.x;
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
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
        if (open && cheb({ x, y }, map.entrance) > SAFE_START_RADIUS + 1) out.push({ x, y });
      }
    return out;
  };

  tiles[idx(map.entrance)] = Tile.Sunshaft;
  map.sunshafts.push(map.entrance);

  // Heartstones: other rooms first, then the stairs room, then the entrance room (one-room floors).
  const others = shuffle(
    rng,
    map.rooms.filter((r) => r !== entranceRoom && r !== stairsRoom),
  );
  const order = [...others, ...map.rooms.filter((r) => r === stairsRoom && r !== entranceRoom), entranceRoom];
  for (let k = 0; k < heartCount; k++) {
    // Spread across rooms; when there are more Heartstones than rooms, rooms take several.
    const room = order[k % order.length]!;
    const spots = interior(room).filter((p) => map.hearts.every((hp) => cheb(hp, p) >= 3));
    if (spots.length === 0) return false;
    const heart = rng.pick(spots);
    tiles[idx(heart)] = Tile.Heartstone;
    map.hearts.push(heart);
    // Half the time, a sunshaft near the Heartstone offers a cheaper solution (one lantern + sunlight).
    if (rng.chance(0.5)) {
      const near: Point[] = [];
      for (let y = room.y; y < room.y + room.h; y++)
        for (let x = room.x; x < room.x + room.w; x++) {
          const d = cheb({ x, y }, heart);
          if (d >= 2 && d <= 3 && tiles[y * w + x] === Tile.Floor) near.push({ x, y });
        }
      if (near.length) {
        const s = rng.pick(near);
        tiles[idx(s)] = Tile.Sunshaft;
        map.sunshafts.push(s);
      }
    }
  }

  // Hidden traps: never near the entrance, next to a Heartstone, or on special tiles.
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] !== Tile.Floor) continue;
    const p = { x: i % w, y: Math.floor(i / w) };
    if (cheb(p, map.entrance) <= SAFE_START_RADIUS) continue;
    if (map.hearts.some((hp) => cheb(p, hp) <= 1)) continue;
    if (rng.chance(roomOf(p) ? TRAP_CHANCE_ROOM : TRAP_CHANCE_CORRIDOR)) map.traps.push(i);
  }
  return true;
}

/** Breadth-first path distance from `from` over walkable tiles; -1 = unreachable. */
export function distanceMap(tiles: Uint8Array, w: number, h: number, from: Point): Int32Array {
  const d = new Int32Array(w * h).fill(-1);
  const start = from.y * w + from.x;
  d[start] = 0;
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
      if (d[ni] !== -1 || !isWalkable(tiles[ni]!)) continue;
      d[ni] = d[i]! + 1;
      queue.push(ni);
    }
  }
  return d;
}

/** The first `count` walkable tiles nearest to `from` (for spawning a party together). */
export function spawnPoints(map: FloorMap, from: Point, count: number): Point[] {
  const d = distanceMap(map.tiles, map.w, map.h, from);
  const traps = new Set(map.traps);
  const cells: { i: number; d: number }[] = [];
  for (let i = 0; i < d.length; i++) {
    const t = map.tiles[i];
    if (d[i]! >= 0 && (t === Tile.Floor || t === Tile.Sunshaft) && !traps.has(i)) cells.push({ i, d: d[i]! });
  }
  cells.sort((a, b) => a.d - b.d || a.i - b.i);
  return cells.slice(0, count).map(({ i }) => ({ x: i % map.w, y: Math.floor(i / map.w) }));
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Empty tiles between two rooms (0 = touching or overlapping). */
function gapBetween(a: Rect, b: Rect): number {
  const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(gx, gy);
}

const center = (r: Rect): Point => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
const dist = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
