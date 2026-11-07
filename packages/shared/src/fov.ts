/**
 * Recursive shadowcasting field of view.
 * `blocks(x, y)` says whether a tile stops sight (out of bounds should return true);
 * `visit(x, y)` is called for every tile in view, including walls that stop sight.
 */
export function computeFov(
  ox: number,
  oy: number,
  radius: number,
  blocks: (x: number, y: number) => boolean,
  visit: (x: number, y: number) => void,
): void {
  visit(ox, oy);
  for (const [xx, xy, yx, yy] of OCTANTS) {
    castLight(ox, oy, radius, 1, 1.0, 0.0, xx, xy, yx, yy, blocks, visit);
  }
}

// Multipliers that map each octant onto the first one.
const OCTANTS: readonly [number, number, number, number][] = [
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [-1, 0, 0, -1],
  [0, -1, -1, 0],
  [0, 1, -1, 0],
  [1, 0, 0, -1],
];

function castLight(
  ox: number,
  oy: number,
  radius: number,
  row: number,
  startSlope: number,
  endSlope: number,
  xx: number,
  xy: number,
  yx: number,
  yy: number,
  blocks: (x: number, y: number) => boolean,
  visit: (x: number, y: number) => void,
): void {
  let start = startSlope;
  if (start < endSlope) return;
  const r2 = radius * radius;
  for (let j = row; j <= radius; j++) {
    let dx = -j - 1;
    const dy = -j;
    let blocked = false;
    let newStart = 0;
    while (dx <= 0) {
      dx++;
      const x = ox + dx * xx + dy * xy;
      const y = oy + dx * yx + dy * yy;
      const leftSlope = (dx - 0.5) / (dy + 0.5);
      const rightSlope = (dx + 0.5) / (dy - 0.5);
      if (start < rightSlope) continue;
      if (endSlope > leftSlope) break;
      if (dx * dx + dy * dy <= r2) visit(x, y);
      const wall = blocks(x, y);
      if (blocked) {
        if (wall) {
          newStart = rightSlope;
        } else {
          blocked = false;
          start = newStart;
        }
      } else if (wall && j < radius) {
        blocked = true;
        castLight(ox, oy, radius, j + 1, start, leftSlope, xx, xy, yx, yy, blocks, visit);
        newStart = rightSlope;
      }
    }
    if (blocked) break;
  }
}
