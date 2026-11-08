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
  MAX_OIL,
  traceBeam,
  beamCellOf,
  JITTERS_MAX,
  JITTERS_DARK,
  JITTERS_DARK_WITH_FRIEND,
  JITTERS_CALM,
  KO_TICKS,
  HEART_FULL,
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

  it('makes every walkable tile reachable and puts the stairs away from the start, across many seeds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const map = generateFloor(seed, (seed % 6) + 1);
      const dist = distanceMap(map.tiles, map.w, map.h, map.entrance);
      for (let i = 0; i < map.tiles.length; i++) {
        if (isWalkable(map.tiles[i]!)) expect(dist[i], `seed ${seed} tile ${i}`).toBeGreaterThanOrEqual(0);
      }
      expect(map.tiles[map.stairs.y * map.w + map.stairs.x]).toBe(Tile.StairsDown);
      expect(dist[map.stairs.y * map.w + map.stairs.x]).toBeGreaterThanOrEqual(4);
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
  return { w, h, tiles, rooms: [], entrance: { x: 1, y: 1 }, stairs: { x: 1, y: 1 }, sunshafts: [], hearts: [], traps: [], emitters: [], mirrors: [] };
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
          expect(Math.max(Math.abs(x - map.entrance.x), Math.abs(y - map.entrance.y))).toBeGreaterThan(2);
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

  it('two lanterns fill a Heartstone in half the time, open the exit, and the party goes down from the ladder', () => {
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
    for (let i = 0; i < HEART_FULL / 2; i++) step(game);
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

  it('one lantern alone charges a Heartstone too, at half the speed, and it fades in the dark', () => {
    const game = two();
    const heart = game.hearts[0]!;
    const a = game.players.get('a')!;
    game.map.sunshafts = []; // no help from sunlight in this test
    game.map.emitters = [];
    a.x = heart.x - 1;
    a.y = heart.y;
    setLantern(game, 'a', true);
    for (let i = 0; i < HEART_FULL / 2; i++) step(game);
    expect(game.hearts[0]!.charge).toBe(HEART_FULL / 2);
    expect(game.exitOpen).toBe(false);
    setLantern(game, 'a', false);
    step(game);
    expect(game.hearts[0]!.charge).toBe(HEART_FULL / 2 - 1);
    setLantern(game, 'a', true);
    for (let i = 0; i < HEART_FULL / 2 + 1; i++) step(game);
    expect(game.exitOpen).toBe(true);
  });
});

describe('compact floors and the Jitters', () => {
  it('beginner floors have 1–2 rooms and deeper floors grow up to 5, all compact', () => {
    const counts: Record<number, Set<number>> = {};
    for (let seed = 1; seed <= 150; seed++) {
      for (const floor of [1, 2, 3, 6]) {
        const map = generateFloor(seed, floor, 2);
        (counts[floor] ??= new Set()).add(map.rooms.length);
        // Far smaller than the old 80×50 dungeon floors.
        expect(map.w * map.h).toBeLessThan(80 * 50 * 0.6);
      }
    }
    expect([...counts[1]!].every((n) => n >= 1 && n <= 2)).toBe(true);
    expect(counts[1]!.has(1)).toBe(true);
    expect([...counts[6]!].every((n) => n >= 3 && n <= 5)).toBe(true);
    expect(counts[6]!.has(5)).toBe(true);
  });

  it('fits 4 Heartstones (8 players) even on beginner floors', () => {
    for (let seed = 1; seed <= 60; seed++) expect(generateFloor(seed, 1, 4).hearts.length).toBe(4);
  });

  const darkGame = () => {
    const game = createGame(5, [
      { id: 'a', name: 'A', color: 1 },
      { id: 'b', name: 'B', color: 2 },
    ]);
    game.map.sunshafts = []; // pitch black everywhere
    game.map.emitters = [];
    return game;
  };

  it('the Jitters fill in the dark, faster alone, and a full meter means panic', () => {
    const game = darkGame();
    const [a, b] = [game.players.get('a')!, game.players.get('b')!];
    // Move them apart so neither has a friend nearby.
    b.x = a.x + 5;
    step(game);
    expect(a.jitters).toBe(JITTERS_DARK);
    b.x = a.x; // together now
    b.y = a.y;
    step(game);
    expect(a.jitters).toBe(JITTERS_DARK + JITTERS_DARK_WITH_FRIEND);
    a.jitters = JITTERS_MAX - 1;
    step(game);
    expect(a.panic).toBe(true);
    // Panicking critters ignore input and can't light a lantern.
    queueIntent(game, 'a', 99, { kind: 'wait' });
    expect(a.queue.length).toBe(0);
    setLantern(game, 'a', true);
    expect(a.lit).toBe(false);
  });

  it('a panicking critter runs around on its own, and light calms it back down', () => {
    const game = darkGame();
    const [a, b] = [game.players.get('a')!, game.players.get('b')!];
    a.jitters = JITTERS_MAX;
    step(game);
    expect(a.panic).toBe(true);
    const start = [a.x, a.y];
    for (let i = 0; i < 10; i++) step(game);
    expect([a.x, a.y]).not.toEqual(start);
    // A friend with a lantern walks over: light calms the meter down to zero.
    b.x = a.x;
    b.y = a.y;
    setLantern(game, 'b', true);
    for (let i = 0; i < Math.ceil(JITTERS_MAX / JITTERS_CALM) + 5 && a.panic; i++) {
      b.x = a.x;
      b.y = a.y;
      step(game);
    }
    expect(a.panic).toBe(false);
    expect(a.jitters).toBe(0);
  });

  it('the run ends when every critter panics at once', () => {
    const game = darkGame();
    for (const p of game.players.values()) p.jitters = JITTERS_MAX;
    step(game);
    expect(game.runOver).toBe(true);
    const tick = game.tick;
    step(game);
    expect(game.tick).toBe(tick); // nothing moves after the run ends
  });
});

describe('sunbeams and mirrors', () => {
  const room = asciiMap(['#######', '#.....#', '#.....#', '#.....#', '#######']);
  const cell = (x: number, y: number) => beamCellOf(room.tiles[y * room.w + x] ?? Tile.Wall);
  const at = (x: number, y: number) => y * room.w + x;

  it('travels straight, bounces off "/" and "\\" mirrors, and stops at walls and critters', () => {
    const e = { x: 1, y: 2, dx: 1, dy: 0 };
    const none = () => undefined;
    expect(traceBeam(room.w, room.h, cell, e, none, () => false)).toEqual([at(1, 2), at(2, 2), at(3, 2), at(4, 2), at(5, 2)]);
    // "/" at (3,2): heading east turns north.
    const slash = (i: number) => (i === at(3, 2) ? 0 : undefined);
    expect(traceBeam(room.w, room.h, cell, e, slash, () => false).at(-1)).toBe(at(3, 1));
    // "\" at (3,2): heading east turns south.
    const back = (i: number) => (i === at(3, 2) ? 1 : undefined);
    expect(traceBeam(room.w, room.h, cell, e, back, () => false).at(-1)).toBe(at(3, 3));
    // A critter at (2,2) is lit, and blocks the rest.
    expect(traceBeam(room.w, room.h, cell, e, none, (i) => i === at(2, 2))).toEqual([at(1, 2), at(2, 2)]);
  });

  it('every generated beam puzzle has a mirror setting that lights its Heartstone, and starts unsolved', () => {
    let puzzles = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const map = generateFloor(seed, (seed % 5) + 1, 2);
      const tileCell = (x: number, y: number) => beamCellOf(map.tiles[y * map.w + x] ?? Tile.Wall);
      const heartIdx = new Set(map.hearts.map((hp) => hp.y * map.w + hp.x));
      const mirrorIdx = map.mirrors.map((m) => m.y * map.w + m.x);
      for (const e of map.emitters) {
        puzzles++;
        expect(map.tiles[e.y * map.w + e.x]).toBe(Tile.Sunbeam);
        // Starting settings: the beam must not already end in a Heartstone.
        const startSet = new Map(map.mirrors.map((m) => [m.y * map.w + m.x, m.orient]));
        const startEnd = traceBeam(map.w, map.h, tileCell, e, (i) => startSet.get(i), () => false).at(-1)!;
        expect(heartIdx.has(startEnd)).toBe(false);
        // Some setting of the mirrors solves it (brute force over every combination).
        let solvable = false;
        for (let mask = 0; mask < 1 << mirrorIdx.length && !solvable; mask++) {
          const set = new Map(mirrorIdx.map((i, k) => [i, ((mask >> k) & 1) as 0 | 1]));
          const end = traceBeam(map.w, map.h, tileCell, e, (i) => set.get(i), () => false).at(-1)!;
          solvable = heartIdx.has(end);
        }
        expect(solvable, `seed ${seed}`).toBe(true);
      }
      // Traps never sit on mirrors or emitters.
      for (const t of map.traps) {
        expect(mirrorIdx).not.toContain(t);
        expect(map.emitters.some((e) => e.y * map.w + e.x === t)).toBe(false);
      }
    }
    expect(puzzles).toBeGreaterThan(80); // most Heartstones get a beam puzzle
  });

  it('turning the mirror you stand on, then stepping out of the beam, charges the Heartstone with sunlight alone', () => {
    // Find a generated floor whose puzzle needs exactly one mirror turned.
    for (let seed = 1; seed < 400; seed++) {
      const game = createGame(seed, [{ id: 'a', name: 'A', color: 1 }]);
      const { map } = game;
      if (map.emitters.length !== 1 || map.hearts.length !== 1) continue;
      game.map.sunshafts = [];
      const heart = map.hearts[0]!.y * map.w + map.hearts[0]!.x;
      const wrong = [...game.mirrors.keys()].find((i) => {
        const trial = new Map(game.mirrors);
        trial.set(i, (1 - trial.get(i)!) as 0 | 1);
        const cellOf = (x: number, y: number) => beamCellOf(map.tiles[y * map.w + x] ?? Tile.Wall);
        return traceBeam(map.w, map.h, cellOf, map.emitters[0]!, (k) => trial.get(k), () => false).at(-1) === heart;
      });
      if (wrong === undefined) continue;
      const a = game.players.get('a')!;
      a.x = wrong % map.w;
      a.y = Math.floor(wrong / map.w);
      queueIntent(game, 'a', 1, { kind: 'rotate' });
      step(game);
      expect(game.mirrors.get(wrong)).not.toBe(map.mirrors.find((m) => m.y * map.w + m.x === wrong)!.orient);
      // Standing on the mirror blocks the beam, so step off it (anywhere away from the path).
      a.x = map.entrance.x;
      a.y = map.entrance.y;
      for (let i = 0; i < HEART_FULL / 2; i++) step(game); // a beam counts as two lights
      expect(game.exitOpen).toBe(true);
      return;
    }
    throw new Error('no one-turn puzzle found');
  });
});
