import { describe, expect, it } from 'vitest';
import {
  Tile,
  computeFov,
  createGame,
  createRng,
  distanceMap,
  generateFloor,
  isWalkable,
  queueIntent,
  step,
  checkMove,
  resolveMove,
  DIRS,
  computeLight,
  setLantern,
  MIN_STAIRS_DISTANCE,
  MAX_OIL,
  KO_TICKS,
  HEART_CHARGE_TICKS,
  OIL_PER_FLOOR,
  type FloorMap,
} from '../src/index';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });
});

describe('map generation', () => {
  it('reproduces the same floor from the same seed', () => {
    expect(generateFloor(1234).tiles).toEqual(generateFloor(1234).tiles);
    expect(generateFloor(1234, 2).tiles).not.toEqual(generateFloor(1234, 1).tiles);
  });

  it('makes every walkable tile reachable and puts the stairs far away, across many seeds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const map = generateFloor(seed);
      const dist = distanceMap(map.tiles, map.w, map.h, map.entrance);
      for (let i = 0; i < map.tiles.length; i++) {
        if (isWalkable(map.tiles[i]!)) expect(dist[i], `seed ${seed} tile ${i}`).toBeGreaterThanOrEqual(0);
      }
      expect(map.tiles[map.stairs.y * map.w + map.stairs.x]).toBe(Tile.StairsDown);
      expect(dist[map.stairs.y * map.w + map.stairs.x]).toBeGreaterThanOrEqual(MIN_STAIRS_DISTANCE);
      // Border is solid.
      for (let x = 0; x < map.w; x++) {
        expect(map.tiles[x]).toBe(Tile.Wall);
        expect(map.tiles[(map.h - 1) * map.w + x]).toBe(Tile.Wall);
      }
    }
  });
});

/** Build a tiny map from ASCII: # wall, . floor. */
function asciiMap(rows: string[]): FloorMap {
  const h = rows.length;
  const w = rows[0]!.length;
  const tiles = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (tiles[y * w + x] = c === '#' ? Tile.Wall : Tile.Floor)));
  return { w, h, tiles, rooms: [], entrance: { x: 1, y: 1 }, stairs: { x: 1, y: 1 }, sunshafts: [], hearts: [], traps: [] };
}

describe('field of view', () => {
  const map = asciiMap([
    '#########',
    '#.......#',
    '#.......#',
    '#...#...#',
    '#.......#',
    '#########',
  ]);
  const blocks = (x: number, y: number) =>
    x < 0 || y < 0 || x >= map.w || y >= map.h || map.tiles[y * map.w + x] === Tile.Wall;

  it('sees the origin, open floor and the walls that stop sight, but not behind a pillar', () => {
    const seen = new Set<string>();
    computeFov(2, 3, 8, blocks, (x, y) => seen.add(`${x},${y}`));
    expect(seen.has('2,3')).toBe(true);
    expect(seen.has('7,1')).toBe(true);
    expect(seen.has('4,3')).toBe(true); // the pillar itself
    expect(seen.has('5,3')).toBe(false); // directly behind it
    expect(seen.has('0,3')).toBe(true); // outer wall
  });

  it('is limited by radius', () => {
    const seen = new Set<string>();
    computeFov(1, 1, 2, blocks, (x, y) => seen.add(`${x},${y}`));
    expect(seen.has('3,1')).toBe(true);
    expect(seen.has('5,1')).toBe(false);
  });
});

describe('movement rules', () => {
  const map = asciiMap(['#####', '#..##', '#...#', '#####']);
  const tile = (x: number, y: number) => map.tiles[y * map.w + x] ?? Tile.Wall;
  const free = () => false;

  it('blocks walls, corner-cutting and occupied tiles', () => {
    expect(checkMove(tile, 1, 1, 'e', free)).toBe('ok');
    expect(checkMove(tile, 2, 1, 'e', free)).toBe('wall');
    expect(checkMove(tile, 2, 2, 'ne', free)).toBe('wall'); // target is a wall
    expect(checkMove(tile, 1, 1, 'se', free)).toBe('ok');
    expect(checkMove(tile, 1, 2, 'ne', free)).toBe('ok');
    expect(checkMove(tile, 1, 1, 'e', (x, y) => x === 2 && y === 1)).toBe('occupied');
  });

  it('slides a blocked diagonal along the open direction instead of stopping', () => {
    // Moving north-east from (1,2): north-east (2,1) is open, so it goes diagonally.
    expect(resolveMove(tile, 1, 2, 'ne', free)).toBe('ne');
    // North-west from (1,2): the target and west are walls, so it slides north.
    expect(resolveMove(tile, 1, 2, 'nw', free)).toBe('n');
    // North-east from (2,2): target (3,1) is a wall; east and north are both open, horizontal wins.
    expect(resolveMove(tile, 2, 2, 'ne', free)).toBe('e');
    // Moving south-east along the bottom wall from (1,2): slides east.
    expect(resolveMove(tile, 1, 2, 'se', free)).toBe('e');
    // Boxed in: nothing open.
    expect(resolveMove(tile, 3, 2, 'se', free)).toBe(null);
    // Straight moves never slide.
    expect(resolveMove(tile, 2, 1, 'e', free)).toBe(null);
  });
});

const findOpenDir = (game: ReturnType<typeof createGame>, id: string) => {
  const p = game.players.get(id)!;
  const tile = (x: number, y: number) => game.map.tiles[y * game.map.w + x] ?? Tile.Wall;
  for (const dir of ['n', 's', 'e', 'w'] as const) {
    if (checkMove(tile, p.x, p.y, dir, (x, y) => [...game.players.values()].some((q) => q.x === x && q.y === y)) === 'ok')
      return dir;
  }
  throw new Error('no open direction');
};

describe('tick simulation', () => {

  it('spawns the party on distinct floor tiles and explores around them', () => {
    const game = createGame(7, [
      { id: 'a', name: 'A', color: 1 },
      { id: 'b', name: 'B', color: 2 },
      { id: 'c', name: 'C', color: 3 },
    ]);
    const spots = new Set([...game.players.values()].map((p) => `${p.x},${p.y}`));
    expect(spots.size).toBe(3);
    expect(game.newlyExplored.length).toBeGreaterThan(10);
  });

  it('a cardinal move takes 2 ticks before the next action resolves, and acks in order', () => {
    const game = createGame(7, [{ id: 'a', name: 'A', color: 1 }]);
    const dir = findOpenDir(game, 'a');
    const start = { ...game.players.get('a')! };
    queueIntent(game, 'a', 1, { kind: 'move', dir });
    queueIntent(game, 'a', 2, { kind: 'wait' });
    step(game); // tick 1: move resolves
    const p = game.players.get('a')!;
    expect(p.lastAck).toBe(1);
    expect(Math.abs(p.x - start.x) + Math.abs(p.y - start.y)).toBe(1);
    step(game); // tick 2: still busy
    expect(p.lastAck).toBe(1);
    step(game); // tick 3: ready again, wait resolves
    expect(p.lastAck).toBe(2);
  });

  it('keeps at most 2 real actions queued; extras become no-ops that still ack', () => {
    const game = createGame(7, [{ id: 'a', name: 'A', color: 1 }]);
    for (let s = 1; s <= 4; s++) queueIntent(game, 'a', s, { kind: 'wait' });
    const p = game.players.get('a')!;
    expect(p.queue.filter((q) => q.action).length).toBe(2);
    step(game); // seq 1 resolves
    step(game); // seq 2 resolves, then no-ops 3 and 4 are dropped
    expect(p.lastAck).toBe(4);
    expect(p.queue.length).toBe(0);
  });

  it('lets critters walk onto and through each other', () => {
    const game = createGame(7, [
      { id: 'a', name: 'A', color: 1 },
      { id: 'b', name: 'B', color: 2 },
    ]);
    const a = game.players.get('a')!;
    const b = game.players.get('b')!;
    const dir = findOpenDir(game, 'a');
    // Put B right where A is about to step.
    b.x = a.x + DIRS[dir][0];
    b.y = a.y + DIRS[dir][1];
    queueIntent(game, 'a', 1, { kind: 'move', dir });
    step(game);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
  });

  it('ignores duplicate sequence numbers', () => {
    const game = createGame(7, [{ id: 'a', name: 'A', color: 1 }]);
    queueIntent(game, 'a', 1, { kind: 'wait' });
    queueIntent(game, 'a', 1, { kind: 'wait' });
    expect(game.players.get('a')!.queue.length).toBe(1);
  });
});

describe('light prototype', () => {
  const two = () =>
    createGame(11, [
      { id: 'a', name: 'A', color: 1 },
      { id: 'b', name: 'B', color: 2 },
    ]);

  it('generates sunshafts, Heartstones scaled to party size, and traps away from the entrance', () => {
    for (let seed = 1; seed <= 100; seed++) {
      for (const hearts of [1, 2, 4]) {
        const map = generateFloor(seed, 1, hearts);
        expect(map.hearts.length).toBe(hearts);
        expect(map.tiles[map.entrance.y * map.w + map.entrance.x]).toBe(Tile.Sunshaft);
        for (const hp of map.hearts) expect(map.tiles[hp.y * map.w + hp.x]).toBe(Tile.Heartstone);
        for (const t of map.traps) {
          const x = t % map.w;
          const y = Math.floor(t / map.w);
          expect(Math.max(Math.abs(x - map.entrance.x), Math.abs(y - map.entrance.y))).toBeGreaterThan(3);
          expect(map.tiles[t]).toBe(Tile.Floor);
        }
        // Heartstones never cut anything off.
        const dist = distanceMap(map.tiles, map.w, map.h, map.entrance);
        for (let i = 0; i < map.tiles.length; i++) if (isWalkable(map.tiles[i]!)) expect(dist[i]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('adds up overlapping light and stops it at walls', () => {
    const map = asciiMap(['#########', '#.......#', '#...#...#', '#########']);
    const tile = (x: number, y: number) => map.tiles[y * map.w + x] ?? Tile.Wall;
    const light = computeLight(map.w, map.h, tile, [
      { x: 1, y: 1, radius: 4, strength: 1 },
      { x: 3, y: 1, radius: 4, strength: 1 },
    ]);
    expect(light.level[1 * map.w + 2]).toBe(2);
    expect(light.level[2 * map.w + 7]).toBe(0); // more than 4 tiles from both sources
    const shadowed = computeLight(map.w, map.h, tile, [{ x: 3, y: 2, radius: 6, strength: 1 }]);
    expect(shadowed.level[2 * map.w + 5]).toBe(0); // directly behind the pillar
    expect(shadowed.level[2 * map.w + 4]).toBe(1); // the pillar itself is lit
  });

  it('burns oil only while lit, and the lantern goes out when oil runs dry', () => {
    const game = two();
    const a = game.players.get('a')!;
    const start = a.oil;
    step(game);
    expect(a.oil).toBe(start);
    setLantern(game, 'a', true);
    step(game);
    expect(a.oil).toBe(start - 1);
    a.oil = 1;
    step(game);
    expect(a.oil).toBe(0);
    expect(a.lit).toBe(false);
    setLantern(game, 'a', true);
    expect(a.lit).toBe(false);
  });

  it('a trap knocks you out, drops queued and new input, then lets you move again', () => {
    const game = two();
    const a = game.players.get('a')!;
    const dir = findOpenDir(game, 'a');
    const target = (a.y + DIRS[dir][1]) * game.map.w + a.x + DIRS[dir][0];
    game.traps.add(target);
    queueIntent(game, 'a', 1, { kind: 'move', dir });
    queueIntent(game, 'a', 2, { kind: 'wait' });
    step(game);
    expect(game.revealedTraps.has(target)).toBe(true);
    expect(a.koUntil).toBe(game.tick + KO_TICKS);
    expect(a.lastAck).toBe(2); // the queued wait was dropped
    queueIntent(game, 'a', 3, { kind: 'wait' });
    expect(a.lastAck).toBe(3); // input while dazed is dropped too
    expect(a.queue.length).toBe(0);
    for (let i = 0; i < KO_TICKS; i++) step(game);
    queueIntent(game, 'a', 4, { kind: 'wait' });
    step(game);
    expect(a.lastAck).toBe(4);
  });

  it('charges a Heartstone with two lights, opens the exit, and goes down when everyone is on the ladder', () => {
    const game = two();
    const heart = game.hearts[0]!;
    const [a, b] = [game.players.get('a')!, game.players.get('b')!];
    // Stand both critters right next to the Heartstone with lanterns lit.
    a.x = heart.x - 1;
    a.y = heart.y;
    b.x = heart.x + 1;
    b.y = heart.y;
    setLantern(game, 'a', true);
    setLantern(game, 'b', true);
    for (let i = 0; i < HEART_CHARGE_TICKS; i++) step(game);
    expect(game.exitOpen).toBe(true);

    const oilBefore = a.oil;
    a.x = b.x = game.map.stairs.x;
    a.y = b.y = game.map.stairs.y;
    step(game);
    expect(game.descended).toBe(true);
    expect(game.floor).toBe(2);
    expect(game.exitOpen).toBe(false);
    expect(a.oil).toBe(Math.min(MAX_OIL, oilBefore - 1 + OIL_PER_FLOOR));
  });

  it('one lantern alone is not enough for a Heartstone', () => {
    const game = two();
    const heart = game.hearts[0]!;
    const a = game.players.get('a')!;
    game.map.sunshafts = []; // no help from sunlight in this test
    a.x = heart.x - 1;
    a.y = heart.y;
    setLantern(game, 'a', true);
    for (let i = 0; i < HEART_CHARGE_TICKS + 5; i++) step(game);
    expect(game.hearts[0]!.charge).toBe(0);
  });
});
