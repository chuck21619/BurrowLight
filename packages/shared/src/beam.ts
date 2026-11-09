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

/**
 * Like `traceBeam`, but a critter with Prism doesn't stop the beam: it splits it into two beams at
 * right angles, which carry on from that critter's tile. Returns every beam segment (the first starts
 * at the emitter); each segment lists its lit tiles in order.
 */
export function traceBeamSplit(
  w: number,
  h: number,
  cell: (x: number, y: number) => BeamCell,
  e: Emitter,
  mirrorAt: (i: number) => MirrorOrient | undefined,
  blocked: (i: number) => boolean,
  prismAt: (i: number) => boolean,
): number[][] {
  const segments: number[][] = [];
  const started = new Set<number>();
  const queue: Emitter[] = [e];
  while (queue.length && segments.length < 64) {
    const start = queue.shift()!;
    const key = (start.y * w + start.x) * 8 + (start.dx + 1) + (start.dy + 1) * 3;
    if (started.has(key)) continue;
    started.add(key);
    const isEmitter = segments.length === 0;
    // A split beam starts on the prism critter's tile, so that tile doesn't block it.
    const path = traceBeam(w, h, cell, start, mirrorAt, (i) => (isEmitter || i !== start.y * w + start.x) && blocked(i));
    segments.push(path);
    const end = path[path.length - 1]!;
    if (path.length > 1 && blocked(end) && prismAt(end) && cell(end % w, Math.floor(end / w)) === 'open') {
      // Work out the heading the beam arrived with, then branch at right angles.
      const prev = path[path.length - 2]!;
      const dx = (end % w) - (prev % w);
      const dy = Math.floor(end / w) - Math.floor(prev / w);
      const x = end % w;
      const y = Math.floor(end / w);
      queue.push({ x, y, dx: dy, dy: dx }, { x, y, dx: -dy, dy: -dx });
    }
  }
  return segments;
}
