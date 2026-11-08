import { computeFov } from './fov';
import { blocksSight } from './map';

export interface LightSource {
  x: number;
  y: number;
  radius: number;
  /** How much this source adds to the light level of each tile it reaches. */
  strength: number;
}

export interface LightMap {
  w: number;
  h: number;
  /** Number of light sources reaching each tile (summed strength). Game rules read this. */
  level: Uint8Array;
  /** Same, but fading with distance from each source. Only for drawing. */
  glow: Float32Array;
}

/**
 * Cast every light source over the map; walls stop light. Overlapping sources add up.
 * `beams` are already-traced sunbeams (tile lists), each adding `beamStrength` along its path.
 */
export function computeLight(
  w: number,
  h: number,
  tile: (x: number, y: number) => number,
  sources: readonly LightSource[],
  beams: readonly (readonly number[])[] = [],
  beamStrength = 2,
): LightMap {
  const level = new Uint8Array(w * h);
  const glow = new Float32Array(w * h);
  const stamp = new Int32Array(w * h); // so one source never counts a tile twice
  sources.forEach((s, si) => {
    const mark = si + 1;
    computeFov(
      s.x,
      s.y,
      s.radius,
      (x, y) => blocksSight(tile(x, y)),
      (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = y * w + x;
        if (stamp[i] === mark) return;
        stamp[i] = mark;
        level[i] = Math.min(255, level[i]! + s.strength);
        const d = Math.hypot(x - s.x, y - s.y);
        glow[i] = glow[i]! + s.strength * Math.max(0.2, 1 - d / (s.radius + 1));
      },
    );
  });
  beams.forEach((path, bi) => {
    const mark = -(bi + 1);
    for (const i of path) {
      if (stamp[i] === mark) continue;
      stamp[i] = mark;
      level[i] = Math.min(255, level[i]! + beamStrength);
      glow[i] = glow[i]! + 1.4;
    }
  });
  return { w, h, level, glow };
}
