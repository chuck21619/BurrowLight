/** 0 = "/" (bottom-left to top-right), 1 = "\" (top-left to bottom-right). */
export type MirrorOrient = 0 | 1;

/** A crack of sunlight in a wall that shines one straight beam. */
export interface Emitter {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** How a tile treats a beam: walls stop it before the tile, Heartstones soak it up. */
export type BeamCell = 'wall' | 'absorb' | 'open';

/** Bounce a beam off a mirror. "/" turns east into north; "\" turns east into south. */
export function reflect(dx: number, dy: number, o: MirrorOrient): [number, number] {
  return o === 0 ? [-dy, -dx] : [dy, dx];
}

/**
 * Follow a beam from its emitter, tile by tile, bouncing off mirrors. It stops at a wall, at a
 * Heartstone (which it lights), or at a critter standing in it (who gets lit and casts a shadow).
 * Returns the lit tiles in order, starting with the emitter's own tile.
 */
export function traceBeam(
  w: number,
  h: number,
  cell: (x: number, y: number) => BeamCell,
  e: Emitter,
  mirrorAt: (i: number) => MirrorOrient | undefined,
  blocked: (i: number) => boolean,
): number[] {
  let { x, y, dx, dy } = e;
  const out = [y * w + x];
  if (blocked(out[0]!)) return out;
  const seen = new Set<number>();
  for (let n = 0; n < w * h * 4; n++) {
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    const c = cell(x, y);
    if (c === 'wall') break;
    const i = y * w + x;
    out.push(i);
    if (c === 'absorb' || blocked(i)) break;
    const m = mirrorAt(i);
    if (m !== undefined) [dx, dy] = reflect(dx, dy, m);
    const key = i * 8 + (dx + 1) + (dy + 1) * 3; // tile + heading, to stop endless loops
    if (seen.has(key)) break;
    seen.add(key);
  }
  return out;
}
