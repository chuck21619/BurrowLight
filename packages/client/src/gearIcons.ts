import type { GearId } from '@burrowlight/shared';

/**
 * Pixel-art icons for the gear picker, drawn from 16×16 pixel maps (same style as the game's
 * sprites) onto a small canvas, and handed out as image URLs.
 */
const ICONS: Record<GearId | 'none', { rows: string[]; pal: Record<string, string> }> = {
  candleCrown: {
    rows: [
      '................',
      '....f...f...f...',
      '...fYf.fYf.fYf..',
      '....w...w...w...',
      '....w...w...w...',
      '....w...w...w...',
      '..GGGGGGGGGGGG..',
      '..GgGGgGGgGGgG..',
      '..GGGGGGGGGGGG..',
      '..gggggggggggg..',
      '................',
    ],
    pal: { f: '#ff9a3c', Y: '#fff0a0', w: '#fff4e0', G: '#e8c46a', g: '#a88430' },
  },
  owlGoggles: {
    rows: [
      '................',
      '................',
      '................',
      '...bbbb..bbbb...',
      '..bBBBBbbBBBBb..',
      '.sbBllBbbBllBbs.',
      'ssbBlLBssBlLBbss',
      '.sbBllBbbBllBbs.',
      '..bBBBBbbBBBBb..',
      '...bbbb..bbbb...',
    ],
    pal: { b: '#5a3a2a', B: '#8a6a48', l: '#7ac8f0', L: '#e8f8ff', s: '#6e4520' },
  },
  mirrorVest: {
    rows: [
      '................',
      '....kk....kk....',
      '...kSSk..kSSk...',
      '..kSSSSkkSSSSk..',
      '..kSWSSSSSSSSk..',
      '..kSSWSSSSSSSk..',
      '..kSSSWSSSSSSk..',
      '..kSSSSWSSSSSk..',
      '..kSSSSSWSSSSk..',
      '..kSSSSSSWSSSk..',
      '..kSSSSSSSWSSk..',
      '..kssssssssssk..',
      '..kkkkkkkkkkkk..',
    ],
    pal: { k: '#55606b', S: '#c8d4e0', s: '#9aa8b8', W: '#ffffff' },
  },
  cozySweater: {
    rows: [
      '................',
      '.....RRRRRR.....',
      '...RRrrrrrrRR...',
      '..RRRRRRRRRRRR..',
      '.RRRRRRRRRRRRRR.',
      '.RRCCCCCCCCCCRR.',
      '.RRRCRRCRRCRRRR.',
      '.RRCCCCCCCCCCRR.',
      '.rRRRRRRRRRRRRr.',
      '.r.RRRRRRRRRR.r.',
      '...RRRRRRRRRR...',
      '...rrrrrrrrrr...',
    ],
    pal: { R: '#c0504d', r: '#8a3634', C: '#f4ead8' },
  },
  diggingDungarees: {
    rows: [
      '................',
      '...b........b...',
      '...b........b...',
      '...bDDDDDDDDb...',
      '...DDDDppDDDD...',
      '...DDDDppDDDD...',
      '...DDDDDDDDDD...',
      '..DDDDDDDDDDDD..',
      '..DDDDDddDDDDD..',
      '..DDDDd..dDDDD..',
      '..DDDD....DDDD..',
      '..DDDD....DDDD..',
      '..dddd....dddd..',
    ],
    pal: { b: '#d8b45a', D: '#4a6a9a', d: '#33507a', p: '#6a8ac0' },
  },
  lanternBelt: {
    rows: [
      '................',
      '................',
      '................',
      '.......kk.......',
      '......k..k......',
      '......BBBB......',
      'LLLLLLBGGBLLLLLL',
      'LLLLLLBOOBLLLLLL',
      'llllllBGGBllllll',
      '......BBBB......',
    ],
    pal: { k: '#4a3a30', B: '#b08a40', G: '#f2d8a0', O: '#ffa040', L: '#8b5a2b', l: '#6e4520' },
  },
  none: {
    rows: [
      '................',
      '................',
      '................',
      '................',
      '.....dd..dd.....',
      '......dddd......',
      '.......dd.......',
      '......dddd......',
      '.....dd..dd.....',
    ],
    pal: { d: '#6b5446' },
  },
};

const cache = new Map<string, string>();

/** A data URL for a gear icon (or 'none' for an empty slot), drawn at 3× scale. */
export function gearIcon(id: GearId | 'none'): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const { rows, pal } = ICONS[id];
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16 * scale;
  const ctx = canvas.getContext('2d')!;
  // Centre the drawing vertically: most maps use only the top rows.
  const used = rows.length;
  const offset = Math.floor((16 - used) / 2);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const color = pal[c];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, (y + offset) * scale, scale, scale);
    });
  });
  const url = canvas.toDataURL();
  cache.set(id, url);
  return url;
}
