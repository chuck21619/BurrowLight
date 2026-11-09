import { hashSeed } from '@burrowlight/shared';
import { Graphics, Rectangle, type Renderer, type Texture } from 'pixi.js';

/** Source pixel size of every tile; drawn at 3x on screen. */
export const SRC = 16;

export interface Textures {
  floor: Texture[];
  wall: Texture;
  stairs: Texture;
  stairsClosed: Texture;
  sunshaft: Texture;
  heartstone: Texture;
  trap: Texture;
  critter: Texture;
  /** Just the edge of the critter's silhouette, for when it's in the dark. White, so it can be tinted. */
  critterOutline: Texture;
  shadow: Texture;
  star: Texture;
  lantern: Texture;
  sunbeam: Texture;
  /** index 0 = unlit, 1 = lit */
  torch: [Texture, Texture];
  /** Paved stone floor: walkable, but you can't dig from or into it. */
  stoneFloor: Texture;
  /** Iron bars on a dirt floor. */
  gate: Texture;
  /** A tunnel opening, drawn over the floor. */
  hole: Texture;
  /** index 0 = "/", 1 = "\" */
  mirror: [Texture, Texture];
  /** A wooden pen door, shut. */
  door: Texture;
  /** The same doorway, open. */
  doorOpen: Texture;
  /** index 0 = up, 1 = pressed down */
  plate: [Texture, Texture];
  /** A sun gem on its pedestal: index 0 = dim, 1 = full of sunlight */
  gem: [Texture, Texture];
  /** A glowcap mushroom (drawn over the floor): index 0 = dark, 1 = glowing */
  glowcap: [Texture, Texture];
}

/**
 * All the game's pixel art, drawn in code: 16×16 sprites in one cozy, earthy style. Tiles are
 * built from small pixel maps (one character per pixel) plus a little seeded grain, so every
 * sprite shares the same palette and the same soft top-left light.
 */
export function makeTextures(renderer: Renderer): Textures {
  const bake = (draw: (g: Graphics) => void): Texture => {
    const g = new Graphics();
    draw(g);
    return renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, SRC, SRC), resolution: 1 });
  };
  const px = (g: Graphics, x: number, y: number, color: number, w = 1, h = 1) => g.rect(x, y, w, h).fill(color);
  /** Seeded per-pixel randomness, so textures look hand-made but never change. */
  const rand = (x: number, y: number, seed: number) => (hashSeed(x, y, seed) % 1000) / 1000;
  /** Draw a pixel map: one string per row, one character per pixel; '.' (or unknown) is transparent. */
  const art = (g: Graphics, rows: string[], pal: Record<string, number>) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < Math.min(SRC, row.length); x++) {
        const c = pal[row[x]!];
        if (c !== undefined) px(g, x, y, c);
      }
    });
  };

  // ---- Ground ----
  const DIRT = [0x7a5a3c, 0x765638, 0x806040, 0x6e5034];
  const dirt = (g: Graphics, seed: number) => {
    for (let y = 0; y < SRC; y++)
      for (let x = 0; x < SRC; x++) {
        const r = rand(x, y, seed);
        px(g, x, y, r < 0.55 ? DIRT[0]! : r < 0.75 ? DIRT[1]! : r < 0.93 ? DIRT[2]! : DIRT[3]!);
      }
  };
  const pebble = (g: Graphics, x: number, y: number) => {
    px(g, x, y, 0xa08a70, 2, 1);
    px(g, x, y + 1, 0x5c4630, 2, 1);
  };
  const floorBase = (g: Graphics) => dirt(g, 1);
  const floor = [
    bake((g) => {
      dirt(g, 1);
      pebble(g, 3, 4);
      pebble(g, 11, 11);
    }),
    bake((g) => {
      dirt(g, 2);
      pebble(g, 9, 3);
      px(g, 3, 12, 0x5c4630, 3, 1); // a crack
      px(g, 5, 13, 0x5c4630, 2, 1);
    }),
    bake((g) => {
      dirt(g, 3);
      pebble(g, 12, 5);
      px(g, 5, 11, 0x7f9c52); // a tiny sprout
      px(g, 4, 10, 0x9ab864);
      px(g, 6, 10, 0x9ab864);
      px(g, 5, 12, 0x5a4430);
    }),
  ];

  // Earth walls: a lit top edge with moss, then stones set in packed earth, dark at the foot.
  const wall = bake((g) =>
    art(
      g,
      [
        'TTtTTTTmMTTTtTTT',
        'TtTTTTmmmmTTTTtT',
        'TTTTtTTTmTTTtTTT',
        'eeeeeeeeeeeeeeee',
        'EHHSSEEEEEHHSSSE',
        'HSSSSsEEEHSSSSSs',
        'SSSSssEEESSSSSss',
        'sssssEEHHsssssEE',
        'EEEEEEHSSSSsEEEE',
        'EHHSEEHSSSSsEEHH',
        'HSSSsEsssssEEHSS',
        'SSSssEEEEEEEHSSS',
        'sssEEEHHSSsEsSSs',
        'EEEEEHSSSSssEsss',
        'eeeeesssssseeeee',
        'BBBBBBBBBBBBBBBB',
      ],
      { T: 0x5c4436, t: 0x6e5444, m: 0x6f8a4a, M: 0x8aa85a, E: 0x3e2f2a, e: 0x33261f, S: 0x6a5a50, s: 0x4e4038, H: 0x857364, B: 0x251b16 },
    ),
  );

  // Paved stone: bevelled grey flagstones with dark grout.
  const stoneFloor = bake((g) => {
    px(g, 0, 0, 0x45474f, SRC, SRC);
    for (const [x, y, w, h] of [
      [0, 0, 8, 7],
      [8, 0, 8, 7],
      [0, 7, 5, 9],
      [5, 7, 7, 9],
      [12, 7, 4, 9],
    ] as const) {
      for (let yy = y; yy < y + h - 1; yy++)
        for (let xx = x; xx < x + w - 1; xx++) px(g, xx, yy, rand(xx, yy, 9) < 0.15 ? 0x62646f : 0x6a6c78);
      px(g, x, y, 0x8a8c97, w - 1, 1); // lit top edge
      px(g, x, y, 0x80828d, 1, h - 1); // lit left edge
      px(g, x, y + h - 2, 0x575963, w - 1, 1); // shaded bottom
      px(g, x + w - 2, y, 0x575963, 1, h - 1); // shaded right
    }
  });

  // A sunshaft: warm, sun-bleached dirt with dust motes and soft rays.
  const sunshaft = bake((g) => {
    for (let y = 0; y < SRC; y++)
      for (let x = 0; x < SRC; x++) {
        const ray = (x + y) % 7 < 2;
        const r = rand(x, y, 4);
        px(g, x, y, ray ? 0xd8b46c : r < 0.6 ? 0xc09a58 : r < 0.85 ? 0xb8924f : 0xcaa462);
      }
    for (const [x, y] of [[3, 2], [11, 5], [6, 11], [13, 13], [8, 7]] as const) px(g, x, y, 0xfff0c0);
  });

  // ---- Ladder hatch ----
  const stairsClosed = bake((g) => {
    floorBase(g);
    art(
      g,
      [
        '................',
        '..kkkkkkkkkkkk..',
        '..kWWwWWWwWWWk..',
        '..kWWwWWWwWWWk..',
        '..kwwwwwwwwwwk..',
        '..kWWWwWWWwWWk..',
        '..kWWWwWOOwWWk..',
        '..kWWWwWOOwWWk..',
        '..kwwwwwwwwwwk..',
        '..kWWwWWWwWWWk..',
        '..kWWwWWWwWWWk..',
        '..kwwwwwwwwwwk..',
        '..kWWWwWWWwWWk..',
        '..kkkkkkkkkkkk..',
        '...dddddddddddd.',
        '................',
      ],
      { k: 0x4a3020, W: 0x9a6a3c, w: 0x7c5230, O: 0xd8b45a, d: 0x5c4630 },
    );
  });
  const stairs = bake((g) => {
    floorBase(g);
    art(
      g,
      [
        '................',
        '..kkkkkkkkkkkk..',
        '..kHHHHHHHHHHk..',
        '..kHLHHHHHHLHk..',
        '..kHLllllllLHk..',
        '..kHLHHHHHHLHk..',
        '..kHLHHHHHHLHk..',
        '..kHLllllllLHk..',
        '..kHLHHHHHHLHk..',
        '..kHLHHHHHHLHk..',
        '..kHLllllllLHk..',
        '..kHLHHHHHHLHk..',
        '..kHLHHHHHHLHk..',
        '..kkkkkkkkkkkk..',
        '................',
        '................',
      ],
      { k: 0x4a3020, H: 0x150e0a, L: 0xd9b77e, l: 0xc49a5c },
    );
  });

  // ---- Heartstones and sun gems: faceted crystals on stone pedestals ----
  const crystal = (g: Graphics, pal: Record<string, number>) => {
    floorBase(g);
    art(
      g,
      [
        '................',
        '.......dd.......',
        '......dCcd......',
        '.....dCwcbd.....',
        '.....dCCcbd.....',
        '....dCCccbbd....',
        '....dCcccbbd....',
        '....dCcccbbd....',
        '.....dccbbd.....',
        '.....dccbbd.....',
        '......dcbd......',
        '...PPPPPPPPPP...',
        '...Ppppppppq....',
        '...qqqqqqqqqq...',
        '....qqqqqqqq....',
        '................',
      ],
      { P: 0xb0a6b8, p: 0x8f8598, q: 0x675e70, ...pal },
    );
  };
  const heartstone = bake((g) => crystal(g, { d: 0x2e6a96, C: 0xd6f6ff, c: 0x9fe3ff, b: 0x5fb0d8, w: 0xffffff }));
  const gem: [Texture, Texture] = [
    bake((g) => crystal(g, { d: 0x5a3a14, C: 0xc4a460, c: 0x9a7a3a, b: 0x7a5a28, w: 0xd8bc80 })),
    bake((g) => crystal(g, { d: 0x9a5a10, C: 0xfff0a8, c: 0xffd25e, b: 0xe8a830, w: 0xffffff })),
  ];

  // ---- Traps, sunbeams, mirrors ----
  const trap = bake((g) => {
    floorBase(g);
    art(
      g,
      [
        '................',
        '................',
        '...t.t.t.t.t....',
        '..oMmMmMmMmMo...',
        '..ommmmmmmmmo...',
        '..o.........o...',
        '..o...oRRo..o...',
        '..o...orro..o...',
        '..o.........o...',
        '..ommmmmmmmmo...',
        '..oMmMmMmMmMo...',
        '...t.t.t.t.t....',
        '................',
      ],
      { o: 0x3a3a42, m: 0x7a7a86, M: 0xb0b0bc, t: 0xece6dc, r: 0xb84a3a, R: 0xf08a7a },
    );
  });

  // A crack in the floor where a sunbeam shines up.
  const sunbeam = bake((g) => {
    floorBase(g);
    g.circle(8, 8, 6).fill({ color: 0xf6dc8a, alpha: 0.35 });
    art(
      g,
      [
        '................',
        '.......y........',
        '.......y........',
        '....y..Y..y.....',
        '.....yYYYy......',
        '.....YWWWY......',
        '..yyYWWWWWYyy...',
        '.....YWWWY......',
        '.....yYYYy......',
        '....y..Y..y.....',
        '.......y........',
        '.......y........',
      ],
      { y: 0xe8c060, Y: 0xffe08a, W: 0xfff8e0 },
    );
  });

  // A mirror: a silver pane in a wooden frame on a little stand (drawn over the floor).
  const mirrorPane = (g: Graphics, flip: boolean) => {
    px(g, 4, 14, 0x5c3c22, 8, 1); // stand shadow
    px(g, 4, 13, 0x8b6a4a, 8, 1); // stand
    px(g, 5, 12, 0xa8845a, 6, 1);
    for (let k = 0; k < 11; k++) {
      const x = 2 + k;
      const y = flip ? 1 + k : 11 - k;
      px(g, x, y + 1, 0x6e4a2a); // frame (shadow side)
      px(g, x, y, 0xe8f0f8); // glass
      px(g, x, y - 1, 0xb8c7d4);
      px(g, x, y - 2, 0x8b6a4a); // frame (lit side)
    }
    px(g, flip ? 4 : 10, flip ? 3 : 3, 0xffffff); // glint
  };
  const mirror: [Texture, Texture] = [bake((g) => mirrorPane(g, false)), bake((g) => mirrorPane(g, true))];

  // ---- Gates and doors ----
  const gate = bake((g) => {
    floorBase(g);
    for (const x of [1, 5, 9, 13]) {
      px(g, x, 2, 0x8a8ea0, 1, 13); // lit side of each bar
      px(g, x + 1, 2, 0x3b3d48, 1, 13); // shaded side
      px(g, x, 1, 0xb8bcc8, 2, 1); // spike
      px(g, x + 1, 15, 0x2a1f1a, 1, 1); // its shadow
    }
    px(g, 0, 4, 0x55586a, SRC, 1);
    px(g, 0, 5, 0x30323c, SRC, 1);
    px(g, 0, 11, 0x55586a, SRC, 1);
    px(g, 0, 12, 0x30323c, SRC, 1);
  });

  const door = bake((g) =>
    art(
      g,
      [
        'EEEEEEEEEEEEEEEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkiIiIiIiIiIikEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWOOWkEE',
        'EkWWwWWwWWOoWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkiIiIiIiIiIikEE',
        'EkWWwWWwWWwWWkEE',
        'EkWWwWWwWWwWWkEE',
        'EkkkkkkkkkkkkkEE',
        'BBBBBBBBBBBBBBBB',
      ],
      { E: 0x3e2f2a, B: 0x251b16, k: 0x4a3020, W: 0xa06e3e, w: 0x7c5230, i: 0x45454f, I: 0x8a8a96, O: 0xe8c46a, o: 0xb08a40 },
    ),
  );
  const doorOpen = bake((g) => {
    floorBase(g);
    px(g, 0, 0, 0x3e2f2a, 2, SRC); // frame
    px(g, 14, 0, 0x3e2f2a, 2, SRC);
    px(g, 2, 0, 0xa06e3e, 2, SRC); // the door swung back against the frame
    px(g, 3, 0, 0x7c5230, 1, SRC);
    px(g, 2, 3, 0x8a8a96, 2, 1);
    px(g, 2, 11, 0x8a8a96, 2, 1);
    px(g, 4, 0, 0x5a4430, 1, SRC); // its shadow
  });

  // A pressure plate: a stone slab in a brass rim, sunk in when pressed.
  const plateDraw = (g: Graphics, down: boolean) => {
    floorBase(g);
    px(g, 2, 2, 0x8a6a30, 12, 12); // rim shadow
    px(g, 2, 2, 0xd8b45a, 11, 11); // brass rim
    px(g, 3, 3, down ? 0x55575f : 0x8a8c98, 9, 9);
    if (down) px(g, 3, 3, 0x45474f, 9, 1); // sunk: shadow on top
    else {
      px(g, 3, 3, 0xa8aab4, 9, 1); // raised: lit top edge
      px(g, 3, 11, 0x6a6c78, 9, 1);
    }
    px(g, 6, 6, down ? 0x45474f : 0x6a6c78, 3, 3); // engraved sun
    px(g, 7, 5, down ? 0x45474f : 0x6a6c78, 1, 5);
    px(g, 5, 7, down ? 0x45474f : 0x6a6c78, 5, 1);
  };
  const plate: [Texture, Texture] = [bake((g) => plateDraw(g, false)), bake((g) => plateDraw(g, true))];

  // ---- Little things drawn over the floor ----
  const capDraw = (g: Graphics, lit: boolean) => {
    if (lit) g.circle(8, 9, 7).fill({ color: 0x7ff0d8, alpha: 0.22 });
    art(
      g,
      [
        '................',
        '................',
        '................',
        '....dCCCd.......',
        '...dCwCCCd......',
        '..dCCCCwCCd.....',
        '..dddddddddd....',
        '.....ss...dCCd..',
        '.....sS..dCwCCd.',
        '.....sS..dddddd.',
        '.....sS....sS...',
        '.....sS....sS...',
        '....ssSS..ssSS..',
        '................',
      ],
      lit
        ? { d: 0x2a9a88, C: 0x7ff0d8, w: 0xf0fffa, s: 0xe8dcc4, S: 0xc8b89c }
        : { d: 0x2e4a46, C: 0x4a6a66, w: 0x6a8a84, s: 0xb8ac94, S: 0x98886c },
    );
  };
  const glowcap: [Texture, Texture] = [bake((g) => capDraw(g, false)), bake((g) => capDraw(g, true))];

  const hole = bake((g) =>
    art(
      g,
      [
        '................',
        '................',
        '................',
        '................',
        '.....cccccc.....',
        '...ccrrrrrrcc...',
        '..crrkkkkkkrrc..',
        '..crkkkkkkkkrc..',
        '..crkkkkkkkkrc..',
        '..crrkkkkkkrrc..',
        '...ccrrrrrrcc...',
        '.....cccccc..c..',
        '.c..............',
      ],
      { c: 0x9a7a54, r: 0x4a3420, k: 0x120c08 },
    ),
  );

  // A standing torch: a wrapped wooden post and an iron bowl, with a flame when lit.
  const torchRows = [
    '................',
    '................',
    '................',
    '................',
    '...oIIIIIIIIo...',
    '....oiiiiiio....',
    '.......PP.......',
    '.......Pp.......',
    '.......cc.......',
    '.......Pp.......',
    '.......Pp.......',
    '.......cc.......',
    '.......Pp.......',
    '.....PPPPpp.....',
    '................',
    '................',
  ];
  const torchPal = { o: 0x2e2c34, I: 0x7a7684, i: 0x4a4652, P: 0x8b5a2b, p: 0x6e4520, c: 0xc8a878 };
  const torch: [Texture, Texture] = [
    bake((g) => art(g, torchRows, torchPal)),
    bake((g) => {
      art(g, torchRows, torchPal);
      art(g, ['.......r........', '......rOr.......', '.....rOYOr......', '.....OYWYO......'], { r: 0xe0602a, O: 0xffa040, Y: 0xffd070, W: 0xfff6c8 });
    }),
  ];

  const star = bake((g) =>
    art(
      g,
      ['................', '................', '................', '................', '.......Y........', '......YYY.......', '...YYYYWYYYY....', '....YYWWWYY.....', '.....YYWYY......', '....YYY.YYY.....', '....YY...YY.....'],
      { Y: 0xffe066, W: 0xfff8d0 },
    ),
  );

  const lantern = bake((g) =>
    art(
      g,
      [
        '................',
        '................',
        '......kkkk......',
        '.....k....k.....',
        '.....BBBBBB.....',
        '....BbbbbbbB....',
        '....bGGGGGGb....',
        '....bGGOOGGb....',
        '....bGOYYOGb....',
        '....bGOWYOGb....',
        '....bGGOOGGb....',
        '....BbbbbbbB....',
        '.....BBBBBB.....',
      ],
      { k: 0x4a3a30, B: 0xb08a40, b: 0x8a6a30, G: 0xf2d8a0, O: 0xffa040, Y: 0xffd070, W: 0xfff6c8 },
    ),
  );

  // The critter: white so it can be tinted with each player's color. Soft shading, inner ears, feet.
  const critter = bake((g) =>
    art(
      g,
      [
        '................',
        '................',
        '....WW....WW....',
        '....Wp....pW....',
        '....Wp....pW....',
        '...WWWWWWWWWW...',
        '...WWWWWWWWWs...',
        '..WWWWWWWWWWss..',
        '..WWWkWWWkWWss..',
        '..WWWkWWWkWWss..',
        '..WcWWWWWWWcss..',
        '..WWWWWmmWWWss..',
        '...WWWWWWWWss...',
        '...sWWWWWWsss...',
        '....ss....ss....',
        '................',
      ],
      { W: 0xffffff, s: 0xdcdcdc, p: 0xffd8d0, k: 0x2a1f1a, c: 0xffc4b0, m: 0x2a1f1a },
    ),
  );

  // The critter silhouette as a pixel mask, then only its edge pixels (for the dark).
  const silhouette = [
    '................',
    '................',
    '....##....##....',
    '....##....##....',
    '....##....##....',
    '...##########...',
    '...##########...',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '..############..',
    '...##########...',
    '...##########...',
    '....##....##....',
    '................',
  ];
  const mask = (x: number, y: number): boolean => silhouette[y]?.[x] === '#';
  const critterOutline = bake((g) => {
    for (let y = 0; y < SRC; y++)
      for (let x = 0; x < SRC; x++) {
        if (!mask(x, y)) continue;
        const edge = !mask(x - 1, y) || !mask(x + 1, y) || !mask(x, y - 1) || !mask(x, y + 1);
        if (edge) px(g, x, y, 0xffffff);
      }
  });

  const shadow = bake((g) => {
    g.ellipse(8, 14.5, 6, 1.8).fill({ color: 0x000000, alpha: 0.32 });
  });

  return {
    floor,
    wall,
    stairs,
    stairsClosed,
    sunshaft,
    heartstone,
    trap,
    critter,
    critterOutline,
    shadow,
    star,
    lantern,
    sunbeam,
    mirror,
    torch,
    stoneFloor,
    gate,
    hole,
    door,
    doorOpen,
    plate,
    gem,
    glowcap,
  };
}
