import { reflect, traceBeam, type BeamCell, type Emitter, type MirrorOrient } from './beam';
import { computeFov } from './fov';
import { createRng, hashSeed, type Rng } from './rng';

export const Tile = {
  Wall: 0,
  Floor: 1,
  StairsDown: 2,
  /** Walkable floor lit from above. */
  Sunshaft: 3,
  /** A pedestal you can't stand on; doesn't block light. */
  Heartstone: 4,
  /** Walkable floor where a crack of sunlight shines one straight beam. */
  Sunbeam: 5,
  /** Paved stone floor: walkable, but too hard to dig a tunnel from or into. */
  StoneFloor: 6,
  /** Iron bars: block walking and light like a wall (critters can tunnel under them). */
  Gate: 7,
  /** A shut wooden door: blocks walking and light (critters can tunnel under it). */
  Door: 8,
  /** The same door, open: walk and see through it. */
  DoorOpen: 9,
  /** A pressure plate: holds its door open while a critter (or a set-down mirror) is on it. */
  Plate: 10,
  /** A sun gem on a pedestal: catch sunlight in it to open its door for good. Doesn't block light. */
  Gem: 11,
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
  /** Sunbeam emitters (on Tile.Sunbeam tiles). */
  emitters: Emitter[];
  /** Rotatable mirrors on floor tiles, with their starting (scrambled) orientation. */
  mirrors: { x: number; y: number; orient: MirrorOrient }[];
  /** Torches on floor tiles: lit by walking over them with a lit lantern; no oil; the Gloom eats them. */
  torches: { x: number; y: number; lit: boolean }[];
  /** Boss rooms: where the Gloom (2×2, top-left corner) starts; its one Heartstone is a Great Heartstone. */
  gloomStart?: Point;
  /** Boss rooms: the lit torch the Gloom eats in its introduction. */
  introTorch?: Point;
  /** Floor 2: index of the room holding the gated Heartstone pen. */
  penRoom?: number;
  /** Walled Heartstone pens with a door, opened by a pressure plate or a sun gem. */
  locks: Lock[];
  /** Glowcap mushrooms (act 2 on): a passing lantern lights them and they glow for a while. */
  glowcaps: Point[];
  /** Act 2 boss rooms: where the Mothmother (2×2, top-left corner) starts. */
  mothStart?: Point;
  /** Act 3 boss rooms: the Sleeping Giant's head (3×2 wall tiles, top-left corner) against the top wall. */
  giant?: Point;
}

/** The floor tiles in front of the Giant's face: light on any of them stirs him. */
export function giantFace(map: { w: number }, head: Point): number[] {
  return [0, 1, 2].map((dx) => (head.y + 2) * map.w + head.x + dx);
}

/** A door and what opens it: a pressure plate (held) or a sun gem (lit by a sunbeam, opens for good). */
export interface Lock {
  door: Point;
  plate?: Point;
  gem?: Point;
}

export const isWalkable = (t: number): boolean =>
  t === Tile.Floor ||
  t === Tile.StairsDown ||
  t === Tile.Sunshaft ||
  t === Tile.Sunbeam ||
  t === Tile.StoneFloor ||
  t === Tile.DoorOpen ||
  t === Tile.Plate;
export const blocksSight = (t: number): boolean => t === Tile.Wall || t === Tile.Gate || t === Tile.Door;
export const beamCellOf = (t: number): BeamCell =>
  blocksSight(t) ? 'wall' : t === Tile.Heartstone || t === Tile.Gem ? 'absorb' : 'open';
/** Ground you can dig a tunnel from, or come up in: dirt, not paved stone. */
export const isDiggableGround = (t: number): boolean => t === Tile.Floor || t === Tile.Sunshaft;
/** What a tunnel can pass under. */
export const canTunnelUnder = (t: number): boolean => t === Tile.Wall || t === Tile.Gate || t === Tile.Door;

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
    if (map && placeFeatures(rng, map, heartCount, floor === BURROW_INTRO_FLOOR, floor >= LOCKS_FROM_FLOOR, floor >= GLOWCAPS_FROM_FLOOR_GEN))
      return map;
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
  return {
    w,
    h,
    tiles: cropped,
    rooms: shifted,
    entrance,
    stairs,
    sunshafts: [],
    hearts: [],
    traps: [],
    emitters: [],
    mirrors: [],
    torches: [],
    locks: [],
    glowcaps: [],
  };
}

const TRAP_CHANCE_ROOM = 0.04;
const TRAP_CHANCE_CORRIDOR = 0.03;
/** Nothing dangerous or important this close to where the party starts. */
const SAFE_START_RADIUS = 2;

/**
 * Sunshafts, Heartstones and hidden traps. Every floor starts in a sunshaft so the party can see.
 * Heartstones go on room tiles with floor all around, so they can never cut off a path.
 */
function placeFeatures(rng: Rng, map: FloorMap, heartCount: number, burrowIntro = false, locks = false, glowcaps = false): boolean {
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
  /** Tiles a puzzle uses (beam path, mirrors, emitters): no traps or other features go here. */
  const used = new Set<number>();
  /** Rooms that must stay dirt (pens, so tunnelling in is always an option). */
  const dirtRooms = new Set<number>();
  for (let k = 0; k < heartCount; k++) {
    // Spread across rooms; when there are more Heartstones than rooms, rooms take several.
    const room = order[k % order.length]!;
    // Burrowing intro: the first Heartstone sits in a gated pen, visible but out of reach on foot.
    if (burrowIntro && k === 0) {
      if (!buildPen(rng, map, room, used, interior, false)) return false;
      map.penRoom = map.rooms.indexOf(room);
      continue;
    }
    // From act 2, some Heartstones sit in a walled pen behind a door: hold a pressure plate, or catch
    // sunlight in a sun gem, to open it (or tunnel in: pen rooms are always dirt).
    if (locks && map.locks.length < MAX_LOCKS && rng.chance(LOCK_CHANCE) && buildPen(rng, map, room, used, interior, true)) {
      dirtRooms.add(map.rooms.indexOf(room));
      continue;
    }
    const spots = interior(room).filter((p) => !used.has(idx(p)) && map.hearts.every((hp) => cheb(hp, p) >= 3));
    if (spots.length === 0) return false;
    const heart = rng.pick(spots);
    tiles[idx(heart)] = Tile.Heartstone;
    map.hearts.push(heart);
    // Most Heartstones get a sunbeam puzzle: free light, if the party sets the mirrors right.
    if (rng.chance(BEAM_PUZZLE_CHANCE) && buildBeamPuzzle(rng, map, heart, used)) continue;
    // Otherwise, half the time, a sunshaft near the Heartstone offers a cheaper solution (one lantern + sunlight).
    if (rng.chance(0.5)) {
      const near: Point[] = [];
      for (let y = room.y; y < room.y + room.h; y++)
        for (let x = room.x; x < room.x + room.w; x++) {
          const d = cheb({ x, y }, heart);
          if (d >= 2 && d <= 3 && tiles[y * w + x] === Tile.Floor && !used.has(y * w + x)) near.push({ x, y });
        }
      if (near.length) {
        const s = rng.pick(near);
        tiles[idx(s)] = Tile.Sunshaft;
        map.sunshafts.push(s);
      }
    }
  }

  // No beam may start out already lighting a Heartstone or sun gem: re-scramble until none does.
  if (map.emitters.length && !scrambleUntilUnsolved(rng, map)) return false;

  // A few unlit torches: free light for whoever carries a flame over them. Never close enough to a
  // Heartstone to charge it, and not right at the start.
  const torchSpots: Point[] = [];
  for (const r of map.rooms)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const p = { x, y };
        if (tiles[y * w + x] !== Tile.Floor || used.has(y * w + x)) continue;
        if (cheb(p, map.entrance) < 3 || map.hearts.some((hp) => cheb(p, hp) <= TORCH_RADIUS_FOR_GEN + 1)) continue;
        torchSpots.push(p);
      }
  for (let k = Math.min(rng.int(1, 3), torchSpots.length); k > 0; k--) {
    const t = torchSpots.splice(rng.int(0, torchSpots.length - 1), 1)[0]!;
    if (map.torches.some((o) => cheb(o, t) < 4)) continue;
    map.torches.push({ ...t, lit: false });
    used.add(t.y * w + t.x);
  }

  // Act 2 on: a few glowcaps, free light for a while, away from the Heartstones (like torches).
  if (glowcaps) {
    for (let k = rng.int(2, 3); k > 0 && torchSpots.length; k--) {
      const c = torchSpots.splice(rng.int(0, torchSpots.length - 1), 1)[0]!;
      const i = c.y * w + c.x;
      if (used.has(i) || map.torches.some((t) => cheb(t, c) < 3) || map.glowcaps.some((o) => cheb(o, c) < 3)) continue;
      map.glowcaps.push(c);
      used.add(i);
    }
  }

  paveRooms(rng, map, entranceRoom, dirtRooms);

  // Hidden traps: never near the entrance, next to a Heartstone, or on special tiles.
  for (let i = 0; i < tiles.length; i++) {
    if ((tiles[i] !== Tile.Floor && tiles[i] !== Tile.StoneFloor) || used.has(i)) continue;
    const p = { x: i % w, y: Math.floor(i / w) };
    if (cheb(p, map.entrance) <= SAFE_START_RADIUS) continue;
    if (map.hearts.some((hp) => cheb(p, hp) <= 1)) continue;
    if (rng.chance(roomOf(p) ? TRAP_CHANCE_ROOM : TRAP_CHANCE_CORRIDOR)) map.traps.push(i);
  }
  return true;
}

/** Doors, plates and sun gems appear from act 2 on. */
export const LOCKS_FROM_FLOOR = 4;
const LOCK_CHANCE = 0.45;
const MAX_LOCKS = 2;

/**
 * Put a Heartstone in a 3×3 pen: a ring of gate bars (the burrowing intro) or of wall with one door
 * (a lock). A lock's door is opened by a pressure plate somewhere in the room, or by a sun gem lit
 * through a mirror puzzle. The pen never cuts anything else off.
 */
function buildPen(
  rng: Rng,
  map: FloorMap,
  room: Rect,
  used: Set<number>,
  interior: (r: Rect) => Point[],
  lock: boolean,
): boolean {
  const { w, h, tiles } = map;
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const sides: [number, number][] = [
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
  ];
  const spots = interior(room).filter((p) => {
    if (map.hearts.some((hp) => cheb(hp, p) < 4)) return false;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const i = (p.y + dy) * w + p.x + dx;
        if (tiles[i] !== Tile.Floor || used.has(i)) return false;
      }
    // Room to stand outside the pen (on dirt to dig from, or at the door).
    return sides.some(([dx, dy]) => tiles[(p.y + dy) * w + p.x + dx] === Tile.Floor);
  });
  if (!spots.length) return false;
  const heart = rng.pick(spots);
  const doorSide = lock ? rng.pick(sides.filter(([dx, dy]) => tiles[(heart.y + dy) * w + heart.x + dx] === Tile.Floor)) : null;
  const door = doorSide ? { x: heart.x + (doorSide[0] / 3) * 2, y: heart.y + (doorSide[1] / 3) * 2 } : null;

  // Lay it down tentatively, so it can be undone if it cuts something off.
  const before = new Map<number, number>();
  const set = (p: Point, t: number) => {
    const i = p.y * w + p.x;
    if (!before.has(i)) before.set(i, tiles[i]!);
    tiles[i] = t;
  };
  const undo = () => {
    for (const [i, t] of before) tiles[i] = t;
  };
  set(heart, Tile.Heartstone);
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) set({ x: heart.x + dx, y: heart.y + dy }, lock ? Tile.Wall : Tile.Gate);
  if (door) set(door, Tile.Door);
  const walkDist = distanceMap(tiles, w, h, map.entrance);
  for (let i = 0; i < tiles.length; i++) {
    const inPen = cheb({ x: i % w, y: Math.floor(i / w) }, heart) <= 1;
    if (!inPen && isWalkable(tiles[i]!) && walkDist[i]! < 0) {
      undo();
      return false;
    }
  }
  const penTiles: number[] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) penTiles.push((heart.y + dy) * w + heart.x + dx);
  const reserved = [...penTiles];
  if (doorSide) reserved.push((heart.y + doorSide[1]) * w + heart.x + doorSide[0]); // the doorstep stays clear
  for (const i of reserved) used.add(i);

  if (door) {
    const lockDef: Lock = { door };
    // A sun gem (opened by a mirror puzzle), or a pressure plate a few steps from the door.
    let made = false;
    if (rng.chance(0.5)) {
      const gemSpots = interior(room).filter(
        (p) => !used.has(p.y * w + p.x) && cheb(p, heart) >= 3 && cheb(p, heart) <= 5 && tiles[p.y * w + p.x] === Tile.Floor,
      );
      for (let tries = 0; tries < 6 && gemSpots.length && !made; tries++) {
        const gem = gemSpots.splice(rng.int(0, gemSpots.length - 1), 1)[0]!;
        tiles[gem.y * w + gem.x] = Tile.Gem;
        used.add(gem.y * w + gem.x);
        if (buildBeamPuzzle(rng, map, gem, used)) {
          lockDef.gem = gem;
          made = true;
        } else {
          tiles[gem.y * w + gem.x] = Tile.Floor;
          used.delete(gem.y * w + gem.x);
        }
      }
    }
    if (!made) {
      const plateSpots: Point[] = [];
      for (let y = room.y; y < room.y + room.h; y++)
        for (let x = room.x; x < room.x + room.w; x++) {
          const p = { x, y };
          const d = cheb(p, door);
          if (d >= 2 && d <= 5 && tiles[y * w + x] === Tile.Floor && !used.has(y * w + x) && walkDist[y * w + x]! >= 0) plateSpots.push(p);
        }
      if (!plateSpots.length) {
        undo();
        for (const i of reserved) used.delete(i);
        return false;
      }
      const plate = rng.pick(plateSpots);
      tiles[plate.y * w + plate.x] = Tile.Plate;
      used.add(plate.y * w + plate.x);
      lockDef.plate = plate;
    }
    map.locks.push(lockDef);
  } else {
    // Keep the area just outside the gate clear too, so there's dirt to dig from.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) used.add((heart.y + dy) * w + heart.x + dx);
  }
  map.hearts.push(heart);
  return true;
}

/** Thickest wall (or gate) a tunnel can go under. */
export const MAX_TUNNEL_SOIL = 3;
/** Floor 2 introduces burrowing with a gated Heartstone. */
export const BURROW_INTRO_FLOOR = 2;
/** Chance a room (other than the entrance room and the gated pen's room) is paved with stone. */
const PAVED_ROOM_CHANCE = 0.3;

/**
 * Pave some rooms with stone: you can walk there, but not dig from or into them. Most ground stays
 * dirt. The entrance room and the gated pen's room are always dirt.
 */
function paveRooms(rng: Rng, map: FloorMap, entranceRoom: Rect, dirtRooms: Set<number>): void {
  const { w, tiles } = map;
  map.rooms.forEach((r, k) => {
    if (r === entranceRoom || k === map.penRoom || dirtRooms.has(k) || !rng.chance(PAVED_ROOM_CHANCE)) return;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (tiles[y * w + x] === Tile.Floor) tiles[y * w + x] = Tile.StoneFloor;
  });
}

/** Matches GLOWCAPS_FROM_FLOOR in rules (kept here to avoid an import cycle). */
const GLOWCAPS_FROM_FLOOR_GEN = 4;
/** Matches TORCH_RADIUS in rules (kept here to avoid an import cycle). */
const TORCH_RADIUS_FOR_GEN = 3;

const BEAM_PUZZLE_CHANCE = 0.75;
const DIR4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Build a sunbeam puzzle for a Heartstone, working backwards: walk out from the Heartstone in a
 * straight line, turn at 1–2 mirrors, and end at a wall where the sunlight comes in. Then check
 * the beam really reaches the Heartstone with the mirrors set right, and scramble them so the
 * party has to fix at least one. Sometimes adds a decoy mirror nearby.
 */
function buildBeamPuzzle(rng: Rng, map: FloorMap, heart: Point, used: Set<number>): boolean {
  const { w, h, tiles } = map;
  const free = (x: number, y: number) =>
    x > 0 && y > 0 && x < w - 1 && y < h - 1 && tiles[y * w + x] === Tile.Floor && !used.has(y * w + x) &&
    Math.max(Math.abs(x - map.entrance.x), Math.abs(y - map.entrance.y)) > 1;
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 0;
    while (free(x + dx * (n + 1), y + dy * (n + 1))) n++;
    return n;
  };

  for (let attempt = 0; attempt < 30; attempt++) {
    const turns = rng.int(1, 2);
    let x = heart.x;
    let y = heart.y;
    let [dx, dy] = rng.pick(DIR4);
    const path: number[] = [];
    const mirrors: { x: number; y: number; orient: MirrorOrient }[] = [];
    let emitter: Emitter | null = null;
    let ok = true;
    for (let t = 0; t <= turns && ok; t++) {
      const max = run(x, y, dx, dy);
      if (max < 2) {
        ok = false;
        break;
      }
      const len = t < turns ? rng.int(2, max) : max;
      for (let s = 1; s <= len; s++) path.push((y + dy * s) * w + x + dx * s);
      x += dx * len;
      y += dy * len;
      if (t < turns) {
        // Turn here at a mirror. The real beam arrives travelling (-ndx,-ndy) and must leave as (-dx,-dy).
        const turnsHere = DIR4.filter(([a, b]) => a !== dx && a !== -dx && b !== dy && b !== -dy).filter(
          ([a, b]) => run(x, y, a, b) >= 2,
        );
        if (!turnsHere.length) {
          ok = false;
          break;
        }
        const [ndx, ndy] = rng.pick(turnsHere);
        const orient = ([0, 1] as MirrorOrient[]).find((o) => {
          const [rx, ry] = reflect(-ndx, -ndy, o);
          return rx === -dx && ry === -dy;
        })!;
        mirrors.push({ x, y, orient });
        [dx, dy] = [ndx, ndy];
      } else {
        // The last tile before the wall is where the sunlight comes in, shining back toward the mirror.
        emitter = { x, y, dx: -dx, dy: -dy };
      }
    }
    if (!ok || !emitter || new Set(path).size !== path.length) continue;

    // Check it: with the right settings the beam must end in this Heartstone.
    const correct = new Map(mirrors.map((m) => [m.y * w + m.x, m.orient]));
    const cell = (cx: number, cy: number) => beamCellOf(cx === emitter!.x && cy === emitter!.y ? Tile.Sunbeam : tiles[cy * w + cx]!);
    const beam = traceBeam(w, h, cell, emitter, (i) => correct.get(i), () => false);
    if (beam[beam.length - 1] !== heart.y * w + heart.x) continue;

    // Scramble: random settings, but never already solved.
    const start = mirrors.map((m) => ({ ...m, orient: rng.int(0, 1) as MirrorOrient }));
    if (start.every((m, k) => m.orient === mirrors[k]!.orient)) start[0]!.orient = (1 - start[0]!.orient) as MirrorOrient;

    tiles[emitter.y * w + emitter.x] = Tile.Sunbeam;
    map.emitters.push(emitter);
    map.mirrors.push(...start);
    for (const i of path) used.add(i);
    for (const i of beam) used.add(i);

    // A decoy mirror off the path gives the room a second thing to think about (or another route).
    if (rng.chance(0.5)) {
      const options: Point[] = [];
      for (let yy = 1; yy < h - 1; yy++)
        for (let xx = 1; xx < w - 1; xx++)
          if (free(xx, yy) && Math.max(Math.abs(xx - heart.x), Math.abs(yy - heart.y)) <= 4) options.push({ x: xx, y: yy });
      if (options.length) {
        const d = rng.pick(options);
        map.mirrors.push({ ...d, orient: rng.int(0, 1) as MirrorOrient });
        used.add(d.y * w + d.x);
      }
    }
    return true;
  }
  return false;
}

function scrambleUntilUnsolved(rng: Rng, map: FloorMap): boolean {
  const { w, h, tiles } = map;
  const hearts = new Set(map.hearts.map((p) => p.y * w + p.x));
  for (const l of map.locks) if (l.gem) hearts.add(l.gem.y * w + l.gem.x);
  const cell = (x: number, y: number) => beamCellOf(tiles[y * w + x]!);
  for (let tries = 0; tries < 40; tries++) {
    const set = new Map(map.mirrors.map((m) => [m.y * w + m.x, m.orient]));
    const solved = map.emitters.some((e) => hearts.has(traceBeam(w, h, cell, e, (i) => set.get(i), () => false).at(-1)!));
    if (!solved) return true;
    for (const m of map.mirrors) m.orient = rng.int(0, 1) as MirrorOrient;
  }
  return false;
}

/**
 * A boss room: one big room with a few pillars, the party's sunshaft on the left, a Great
 * Heartstone toward the right, sunbeams shining in from the walls with mirrors along them, and
 * the Gloom waiting far from both. The ladder opens when the Great Heartstone is full.
 */
export function generateBossFloor(seed: number, floor: number): FloorMap {
  const rng = createRng(hashSeed(seed, floor, 0xb055));
  for (let attempt = 0; attempt < 200; attempt++) {
    const map = tryBossRoom(rng);
    if (map) return map;
  }
  throw new Error(`could not generate boss floor for seed ${seed}`);
}

/** Share of a boss room's open floor that some mirror setting can put a sunbeam across. */
export const BEAM_SHARE = 0.4;

function tryBossRoom(rng: Rng): FloorMap | null {
  const w = rng.int(20, 24);
  const h = rng.int(13, 15);
  const tiles = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) tiles[y * w + x] = Tile.Floor;
  const at = (x: number, y: number) => tiles[y * w + x]!;
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const entrance = { x: 2, y: Math.floor(h / 2) };
  const heart = { x: w - rng.int(6, 8), y: rng.int(4, h - 5) };
  const stairs = { x: w - 2, y: rng.chance(0.5) ? 1 : h - 2 };

  // A few pillars to herd around, away from the start and the Great Heartstone.
  for (let k = rng.int(3, 5); k > 0; k--) {
    const px = rng.int(5, w - 4);
    const py = rng.int(2, h - 3);
    const [pw, ph] = rng.chance(0.5) ? [2, 1] : [1, 2];
    if (cheb({ x: px, y: py }, heart) <= 2 || cheb({ x: px, y: py }, stairs) <= 1) continue;
    for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) tiles[y * w + x] = Tile.Wall;
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(heart.x + dx, heart.y + dy) !== Tile.Floor) return null;
  tiles[entrance.y * w + entrance.x] = Tile.Sunshaft;
  tiles[heart.y * w + heart.x] = Tile.Heartstone;
  tiles[stairs.y * w + stairs.x] = Tile.StairsDown;

  // Sunbeams shine in from three walls; mirrors sit along their paths so the party can swing them.
  const emitters: Emitter[] = [];
  const mirrors: { x: number; y: number; orient: MirrorOrient }[] = [];
  const reserved = new Set([entrance, heart, stairs].map((p) => p.y * w + p.x));
  const spots: [Point, number, number][] = [
    [{ x: rng.int(6, w - 3), y: 1 }, 0, 1],
    [{ x: rng.int(6, w - 3), y: h - 2 }, 0, -1],
    [{ x: w - 2, y: rng.int(2, h - 3) }, -1, 0],
  ];
  for (const [p, dx, dy] of spots) {
    if (reserved.has(p.y * w + p.x) || at(p.x, p.y) !== Tile.Floor) continue;
    tiles[p.y * w + p.x] = Tile.Sunbeam;
    reserved.add(p.y * w + p.x);
    emitters.push({ ...p, dx, dy });
    // Walk the straight beam and drop 1–2 mirrors on it.
    const line: Point[] = [];
    for (let s = 2; ; s++) {
      const q = { x: p.x + dx * s, y: p.y + dy * s };
      if (at(q.x, q.y) !== Tile.Floor) break;
      if (!reserved.has(q.y * w + q.x)) line.push(q);
    }
    if (!line.length) continue;
    for (const m of rng.chance(0.5) ? [rng.pick(line)] : [rng.pick(line), rng.pick(line)]) {
      if (reserved.has(m.y * w + m.x)) continue;
      mirrors.push({ ...m, orient: rng.int(0, 1) as MirrorOrient });
      reserved.add(m.y * w + m.x);
    }
  }
  if (emitters.length < 2) return null;
  for (let k = 0; k < 2; k++) {
    const m = { x: rng.int(4, w - 3), y: rng.int(2, h - 3) };
    if (at(m.x, m.y) === Tile.Floor && !reserved.has(m.y * w + m.x)) {
      mirrors.push({ ...m, orient: rng.int(0, 1) as MirrorOrient });
      reserved.add(m.y * w + m.x);
    }
  }

  // Everything reachable.
  const d = distanceMap(tiles, w, h, entrance);
  for (let i = 0; i < tiles.length; i++) if (isWalkable(tiles[i]!) && d[i]! < 0) return null;

  // Guarantee: mirrors can swing sunbeams across a good share of the open room, so a critter with a
  // lantern can lead the Gloom across a beam's path and someone can flip it onto it. Add mirrors on
  // beam-reachable tiles until the share is met. (No beams are needed around the Great Heartstone.)
  const open = [] as number[];
  for (let i = 0; i < tiles.length; i++) if (isWalkable(tiles[i]!)) open.push(i);
  const share = () => {
    const reach = beamReach(w, h, tiles, emitters, new Set(mirrors.map((m) => m.y * w + m.x)));
    return open.filter((i) => reach.has(i)).length / open.length;
  };
  let have = share();
  for (let added = 0; added < 6 && have < BEAM_SHARE; added++) {
    const reach = beamReach(w, h, tiles, emitters, new Set(mirrors.map((m) => m.y * w + m.x)));
    let bestTile = -1;
    let bestHave = have;
    for (const i of reach) {
      if (tiles[i] !== Tile.Floor || reserved.has(i)) continue;
      mirrors.push({ x: i % w, y: Math.floor(i / w), orient: 0 });
      const n = share();
      mirrors.pop();
      if (n > bestHave) {
        bestHave = n;
        bestTile = i;
      }
    }
    if (bestTile < 0) break;
    mirrors.push({ x: bestTile % w, y: Math.floor(bestTile / w), orient: rng.int(0, 1) as MirrorOrient });
    reserved.add(bestTile);
    have = bestHave;
  }
  if (have < BEAM_SHARE) return null;

  // The Gloom starts far from the Great Heartstone and the party, outside any starting beam.
  const mset = new Map(mirrors.map((m) => [m.y * w + m.x, m.orient]));
  const cell = (x: number, y: number) => beamCellOf(tiles[y * w + x]!);
  const lit = new Set(emitters.flatMap((e) => traceBeam(w, h, cell, e, (i) => mset.get(i), () => false)));
  const starts: Point[] = [];
  for (let y = 1; y < h - 2; y++)
    for (let x = 5; x < w - 2; x++) {
      const foot = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      if (foot.every((i) => tiles[i] === Tile.Floor && !lit.has(i) && !reserved.has(i)) && cheb({ x, y }, heart) >= 7)
        starts.push({ x, y });
    }
  if (!starts.length) return null;
  const gloomStart = rng.pick(starts);
  const gloomFoot = new Set([0, 1].flatMap((dy) => [0, 1].map((dx) => (gloomStart.y + dy) * w + gloomStart.x + dx)));

  // Torches around the room, all unlit except one a few steps from the Gloom: it eats that one in
  // its intro, so the fight starts in darkness and the party has to light the rest.
  const torchOk = (p: Point) =>
    tiles[p.y * w + p.x] === Tile.Floor && !reserved.has(p.y * w + p.x) && !lit.has(p.y * w + p.x) && !gloomFoot.has(p.y * w + p.x);
  const intro: Point[] = [];
  for (let y = gloomStart.y - 4; y <= gloomStart.y + 5; y++)
    for (let x = gloomStart.x - 4; x <= gloomStart.x + 5; x++) {
      const p = { x, y };
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1 || !torchOk(p)) continue;
      const d = Math.max(Math.abs(x - (gloomStart.x + 0.5)), Math.abs(y - (gloomStart.y + 0.5)));
      if (d >= 2.5 && d <= 4.5 && cheb(p, heart) > TORCH_RADIUS_FOR_GEN + 1) intro.push(p);
    }
  if (!intro.length) return null;
  const introTorch = rng.pick(intro);
  const torches = [{ ...introTorch, lit: true }];
  reserved.add(introTorch.y * w + introTorch.x);
  for (let tries = 0; tries < 60 && torches.length < 5; tries++) {
    const p = { x: rng.int(2, w - 3), y: rng.int(1, h - 2) };
    if (!torchOk(p) || cheb(p, heart) <= TORCH_RADIUS_FOR_GEN + 1 || cheb(p, entrance) < 3) continue;
    if (torches.some((t) => cheb(t, p) < 4)) continue;
    torches.push({ ...p, lit: false });
    reserved.add(p.y * w + p.x);
  }

  return {
    w,
    h,
    tiles,
    rooms: [{ x: 1, y: 1, w: w - 2, h: h - 2 }],
    entrance,
    stairs,
    sunshafts: [entrance],
    hearts: [heart],
    traps: [],
    emitters,
    mirrors,
    torches,
    gloomStart,
    introTorch,
    locks: [],
    glowcaps: [],
  };
}

/**
 * The act 3 boss room: the Giant's kitchen. His head lies against the top wall, snoring; the Great
 * Heartstone sits a few steps from his face, half hidden behind kitchen counters. Light on his face
 * stirs him, so the party has to light the stone from the shadows: from behind counters, with a
 * mirror puzzle that routes a sunbeam around him, and with torches set well away from him.
 * Guaranteed: several spots where a plain lantern lights the stone without touching his face.
 */
export function generateGiantFloor(seed: number, floor: number): FloorMap {
  const rng = createRng(hashSeed(seed, floor, 0x61a));
  for (let attempt = 0; attempt < 400; attempt++) {
    const map = tryGiantRoom(rng);
    if (map) return map;
  }
  throw new Error(`could not generate giant floor for seed ${seed}`);
}

/** Spots a lantern (radius 4) could stand on to light the Great Heartstone without lighting the Giant's face. */
export function giantSafeSpots(map: FloorMap, radius = 4): number[] {
  const { w, h, tiles } = map;
  const heart = map.hearts[0]!;
  const face = new Set(giantFace(map, map.giant!));
  const blocks = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || blocksSight(tiles[y * w + x]!);
  const reach = distanceMap(tiles, w, h, map.entrance);
  const out: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (!isWalkable(tiles[i]!) || reach[i]! < 0) continue;
    let stone = false;
    let wakes = false;
    computeFov(i % w, Math.floor(i / w), radius, blocks, (x, y) => {
      const j = y * w + x;
      if (x === heart.x && y === heart.y) stone = true;
      if (face.has(j)) wakes = true;
    });
    if (stone && !wakes) out.push(i);
  }
  return out;
}

function tryGiantRoom(rng: Rng): FloorMap | null {
  const w = rng.int(20, 24);
  const h = rng.int(13, 15);
  const tiles = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) tiles[y * w + x] = Tile.Floor;
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const entrance = { x: 2, y: rng.int(Math.floor(h / 2), h - 3) };
  const stairs = { x: w - 2, y: h - 2 };
  const giant = { x: rng.int(7, w - 10), y: 1 };
  for (let y = 1; y <= 2; y++) for (let x = giant.x; x < giant.x + 3; x++) tiles[y * w + x] = Tile.Wall;
  const faceTiles = giantFace({ w }, giant);
  const heart = { x: giant.x + 1 + rng.int(-3, 3), y: rng.int(6, Math.min(8, h - 4)) };
  // Kitchen counters: short walls between his face and the stone, and a few more around the room.
  for (let k = rng.int(2, 3); k > 0; k--) {
    const len = rng.int(2, 4);
    const cx = rng.int(Math.max(2, heart.x - 4), Math.min(w - 2 - len, heart.x + 2));
    const cy = rng.int(4, heart.y - 1);
    for (let x = cx; x < cx + len; x++) if (cheb({ x, y: cy }, heart) > 1) tiles[cy * w + x] = Tile.Wall;
  }
  for (let k = rng.int(2, 3); k > 0; k--) {
    const px = rng.int(4, w - 4);
    const py = rng.int(3, h - 3);
    if (cheb({ x: px, y: py }, heart) <= 2 || cheb({ x: px, y: py }, entrance) <= 2 || cheb({ x: px, y: py }, stairs) <= 1) continue;
    tiles[py * w + px] = Tile.Wall;
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles[(heart.y + dy) * w + heart.x + dx] !== Tile.Floor) return null;
  if (faceTiles.some((i) => tiles[i] !== Tile.Floor)) return null;
  tiles[entrance.y * w + entrance.x] = Tile.Sunshaft;
  tiles[heart.y * w + heart.x] = Tile.Heartstone;
  tiles[stairs.y * w + stairs.x] = Tile.StairsDown;
  const d = distanceMap(tiles, w, h, entrance);
  for (let i = 0; i < tiles.length; i++) if (isWalkable(tiles[i]!) && d[i]! < 0) return null;
  const blocks = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || blocksSight(tiles[y * w + x]!);
  const lightsFace = (x: number, y: number, r: number) => {
    let hit = false;
    computeFov(x, y, r, blocks, (fx, fy) => {
      if (faceTiles.includes(fy * w + fx)) hit = true;
    });
    return hit;
  };
  if (lightsFace(entrance.x, entrance.y, 3)) return null; // the start must be safe

  const map: FloorMap = {
    w,
    h,
    tiles,
    rooms: [{ x: 1, y: 1, w: w - 2, h: h - 2 }],
    entrance,
    stairs,
    sunshafts: [entrance],
    hearts: [heart],
    traps: [],
    emitters: [],
    mirrors: [],
    torches: [],
    locks: [],
    glowcaps: [],
    giant,
  };
  if (giantSafeSpots(map).length < 4) return null;

  // A mirror puzzle that brings a sunbeam to the stone without crossing his face (or the head).
  const used = new Set<number>([entrance.y * w + entrance.x, stairs.y * w + stairs.x]);
  for (const i of faceTiles) used.add(i);
  for (const i of faceTiles) used.add(i + w); // and the row in front, so he isn't flooded right after
  if (rng.chance(0.85)) buildBeamPuzzle(rng, map, heart, used);
  // Every beam, solved or scrambled, must stay off his face: no sunbeam may ever reach it.
  const reach = beamReach(w, h, tiles, map.emitters, new Set(map.mirrors.map((m) => m.y * w + m.x)));
  if (faceTiles.some((i) => reach.has(i))) return null;
  if (map.emitters.length && !scrambleUntilUnsolved(rng, map)) return null;

  // Torches, all safely out of sight of his face.
  for (let tries = 0; tries < 80 && map.torches.length < 3; tries++) {
    const p = { x: rng.int(2, w - 3), y: rng.int(2, h - 2) };
    const i = p.y * w + p.x;
    if (tiles[i] !== Tile.Floor || used.has(i) || cheb(p, heart) <= TORCH_RADIUS_FOR_GEN + 1 || cheb(p, entrance) < 3) continue;
    if (map.torches.some((t) => cheb(t, p) < 4) || map.mirrors.some((m) => m.x === p.x && m.y === p.y)) continue;
    if (lightsFace(p.x, p.y, TORCH_RADIUS_FOR_GEN)) continue;
    map.torches.push({ ...p, lit: false });
    used.add(i);
  }
  return map;
}

/**
 * The act 2 boss room: one big glowcap grotto. The party's sunshaft on the left, a Great Heartstone
 * toward the right, glowcaps scattered all around (the decoys), a few pillars, and the Mothmother
 * resting far from the stone. No sunbeams here: this fight is about decoys, not pinning.
 */
export function generateMothFloor(seed: number, floor: number): FloorMap {
  const rng = createRng(hashSeed(seed, floor, 0x307));
  for (let attempt = 0; attempt < 200; attempt++) {
    const map = tryMothRoom(rng);
    if (map) return map;
  }
  throw new Error(`could not generate moth floor for seed ${seed}`);
}

function tryMothRoom(rng: Rng): FloorMap | null {
  const w = rng.int(20, 24);
  const h = rng.int(13, 15);
  const tiles = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) tiles[y * w + x] = Tile.Floor;
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const entrance = { x: 2, y: Math.floor(h / 2) };
  const heart = { x: w - rng.int(6, 8), y: rng.int(4, h - 5) };
  const stairs = { x: w - 2, y: rng.chance(0.5) ? 1 : h - 2 };
  for (let k = rng.int(3, 5); k > 0; k--) {
    const px = rng.int(5, w - 4);
    const py = rng.int(2, h - 3);
    const [pw, ph] = rng.chance(0.5) ? [2, 1] : [1, 2];
    if (cheb({ x: px, y: py }, heart) <= 2 || cheb({ x: px, y: py }, stairs) <= 1) continue;
    for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) tiles[y * w + x] = Tile.Wall;
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles[(heart.y + dy) * w + heart.x + dx] !== Tile.Floor) return null;
  tiles[entrance.y * w + entrance.x] = Tile.Sunshaft;
  tiles[heart.y * w + heart.x] = Tile.Heartstone;
  tiles[stairs.y * w + stairs.x] = Tile.StairsDown;
  const d = distanceMap(tiles, w, h, entrance);
  for (let i = 0; i < tiles.length; i++) if (isWalkable(tiles[i]!) && d[i]! < 0) return null;

  // Glowcaps all around the room, away from the stone and the start, spread out.
  const glowcaps: Point[] = [];
  for (let tries = 0; tries < 200 && glowcaps.length < 8; tries++) {
    const p = { x: rng.int(2, w - 3), y: rng.int(1, h - 2) };
    if (tiles[p.y * w + p.x] !== Tile.Floor || cheb(p, heart) < 4 || cheb(p, entrance) < 3 || cheb(p, stairs) < 2) continue;
    if (glowcaps.some((g) => cheb(g, p) < 4)) continue;
    glowcaps.push(p);
  }
  if (glowcaps.length < 6) return null;
  // She rests far from the stone (she flies, so walls don't matter for her).
  const starts: Point[] = [];
  for (let y = 1; y < h - 2; y++) for (let x = 5; x < w - 2; x++) if (cheb({ x, y }, heart) >= 8 && cheb({ x, y }, entrance) >= 5) starts.push({ x, y });
  if (!starts.length) return null;
  return {
    w,
    h,
    tiles,
    rooms: [{ x: 1, y: 1, w: w - 2, h: h - 2 }],
    entrance,
    stairs,
    sunshafts: [entrance],
    hearts: [heart],
    traps: [],
    emitters: [],
    mirrors: [],
    torches: [],
    locks: [],
    glowcaps,
    mothStart: rng.pick(starts),
  };
}

/** Every 2×2 spot (as its four tiles) where the Gloom would be touching the Heartstone. */
export function gloomGoalSpots(w: number, h: number, tiles: Uint8Array, heart: Point): number[][] {
  const spots: number[][] = [];
  for (let y = heart.y - 2; y <= heart.y + 1; y++)
    for (let x = heart.x - 2; x <= heart.x + 1; x++) {
      if (x < 1 || y < 1 || x + 1 >= w - 1 || y + 1 >= h - 1) continue;
      const foot = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      if (foot.every((i) => isWalkable(tiles[i]!))) spots.push(foot);
    }
  return spots;
}

/**
 * Every tile some setting of the mirrors could send a sunbeam through: beams are followed through
 * each mirror both ways at once. (Slightly generous when one mirror is hit twice; fine for checks.)
 */
export function beamReach(w: number, h: number, tiles: Uint8Array, emitters: Emitter[], mirrors: Set<number>): Set<number> {
  const lit = new Set<number>();
  const seen = new Set<number>();
  const stack: [number, number, number, number][] = emitters.map((e) => [e.x, e.y, e.dx, e.dy]);
  for (const e of emitters) lit.add(e.y * w + e.x);
  while (stack.length) {
    let [x, y, dx, dy] = stack.pop()!;
    for (;;) {
      x += dx;
      y += dy;
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      const c = beamCellOf(tiles[y * w + x]!);
      if (c === 'wall') break;
      const i = y * w + x;
      lit.add(i);
      if (c === 'absorb') break;
      const key = i * 8 + (dx + 1) + (dy + 1) * 3;
      if (seen.has(key)) break;
      seen.add(key);
      if (mirrors.has(i)) {
        for (const o of [0, 1] as MirrorOrient[]) {
          const [rx, ry] = reflect(dx, dy, o);
          stack.push([x, y, rx, ry]);
        }
        break;
      }
    }
  }
  return lit;
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
