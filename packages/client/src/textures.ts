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
  soil: Texture;
  /** A tunnel opening, drawn over the floor. */
  hole: Texture;
  /** index 0 = "/", 1 = "\" */
  mirror: [Texture, Texture];
}

/** Placeholder pixel art drawn in code until the CC0 tileset goes in (M5). */
export function makeTextures(renderer: Renderer): Textures {
  const bake = (draw: (g: Graphics) => void): Texture => {
    const g = new Graphics();
    draw(g);
    return renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, SRC, SRC), resolution: 1 });
  };
  const px = (g: Graphics, x: number, y: number, color: number, w = 1, h = 1) => g.rect(x, y, w, h).fill(color);

  const floorBase = (g: Graphics) => px(g, 0, 0, 0x7a5a3c, SRC, SRC);
  const specks: [number, number][][] = [
    [[3, 4], [11, 2], [7, 10], [13, 13], [2, 12]],
    [[5, 6], [12, 9], [9, 3], [3, 14]],
    [[2, 2], [10, 7], [6, 13], [14, 5], [8, 8]],
  ];
  const floor = specks.map((set, v) =>
    bake((g) => {
      floorBase(g);
      for (const [x, y] of set) px(g, x, y, v === 1 ? 0x8c6a48 : 0x664a30);
      if (v === 2) px(g, 11, 12, 0x8fa860, 2, 1); // a tiny sprout
    }),
  );

  const wall = bake((g) => {
    px(g, 0, 0, 0x3e2f2a, SRC, SRC);
    px(g, 0, 0, 0x5c4436, SRC, 4); // top face catches the lantern light
    px(g, 0, 8, 0x33261f, SRC, 1);
    px(g, 0, 12, 0x33261f, SRC, 1);
    px(g, 5, 4, 0x33261f, 1, 4);
    px(g, 11, 8, 0x33261f, 1, 4);
    px(g, 3, 12, 0x33261f, 1, 4);
    px(g, 9, 5, 0x6f8a4a, 2, 1); // root / moss
  });

  const stairs = bake((g) => {
    floorBase(g);
    px(g, 3, 2, 0x2a1f1a, 10, 12);
    px(g, 4, 2, 0xd9b77e, 1, 12);
    px(g, 11, 2, 0xd9b77e, 1, 12);
    for (const y of [4, 7, 10, 13]) px(g, 4, y, 0xd9b77e, 8, 1);
  });

  const stairsClosed = bake((g) => {
    floorBase(g);
    px(g, 3, 3, 0x8b5a2b, 10, 10); // wooden hatch
    px(g, 3, 6, 0x6e4520, 10, 1);
    px(g, 3, 9, 0x6e4520, 10, 1);
    px(g, 7, 7, 0xd9b77e, 2, 2); // latch
  });

  const sunshaft = bake((g) => {
    px(g, 0, 0, 0xb08a4c, SRC, SRC);
    for (const [x, y] of [[2, 3], [9, 1], [12, 10], [5, 12], [7, 6]] as const) px(g, x, y, 0xf6dc8a);
    px(g, 3, 0, 0xe8c67a, 2, SRC); // light rays
    px(g, 10, 0, 0xe8c67a, 2, SRC);
  });

  const heartstone = bake((g) => {
    floorBase(g);
    px(g, 3, 11, 0x8a8090, 10, 4); // pedestal
    px(g, 4, 10, 0x9d93a3, 8, 1);
    px(g, 6, 3, 0x9fe3ff, 4, 7); // crystal
    px(g, 7, 2, 0xc8f1ff, 2, 1);
    px(g, 7, 4, 0xe6fbff, 1, 3);
  });

  const trap = bake((g) => {
    floorBase(g);
    px(g, 3, 6, 0x6b6460, 10, 4); // snap trap base
    for (const x of [3, 5, 7, 9, 11]) {
      px(g, x, 4, 0xd8d0c4, 1, 2); // teeth
      px(g, x, 10, 0xd8d0c4, 1, 2);
    }
    px(g, 7, 7, 0xe07a5f, 2, 2); // trigger
  });

  const sunbeam = bake((g) => {
    floorBase(g);
    g.circle(8, 8, 5).fill(0xf6dc8a);
    g.circle(8, 8, 3).fill(0xfff6d0);
    for (const [x, y] of [[8, 1], [8, 14], [1, 8], [14, 8]] as const) px(g, x, y, 0xf6dc8a);
  });

  // Mirrors: a silver pane on a little wooden stand, drawn over the floor tile.
  const mirrorPane = (g: Graphics, flip: boolean) => {
    px(g, 3, 13, 0x8b6a4a, 10, 2); // stand
    for (let k = 0; k < 10; k++) {
      const x = 3 + k;
      const y = flip ? 3 + k : 12 - k;
      px(g, x, y, 0x55606b, 1, 1); // frame edge
      px(g, x, y - 1, 0xdfe8f0, 1, 1); // glass
      px(g, x, y - 2, 0xb8c7d4, 1, 1);
    }
  };
  const mirror: [Texture, Texture] = [bake((g) => mirrorPane(g, false)), bake((g) => mirrorPane(g, true))];

  // Soft soil: lumpy, lighter than the stone walls, so it reads as diggable.
  const soil = bake((g) => {
    px(g, 0, 0, 0x6b4a2e, SRC, SRC);
    for (const [x, y, c] of [
      [2, 3, 0x7d5a3a],
      [9, 2, 0x5a3d25],
      [5, 8, 0x7d5a3a],
      [12, 7, 0x5a3d25],
      [3, 12, 0x5a3d25],
      [10, 12, 0x7d5a3a],
      [7, 5, 0x8a6a48],
      [13, 13, 0x8a6a48],
    ] as const)
      px(g, x, y, c, 2, 1);
    px(g, 0, 0, 0x7d5a3a, SRC, 1);
  });

  const hole = bake((g) => {
    g.ellipse(8, 9, 6, 4).fill(0x3a2a1c);
    g.ellipse(8, 9, 4, 2.5).fill(0x120c08);
    px(g, 2, 7, 0x8a6a48, 2, 1);
    px(g, 12, 11, 0x8a6a48, 2, 1);
  });

  // A little standing torch: a wooden post and a metal bowl, with a flame when lit (drawn over the floor).
  const torchBase = (g: Graphics) => {
    px(g, 7, 7, 0x6e4520, 2, 8); // post
    px(g, 5, 14, 0x6e4520, 6, 1); // foot
    px(g, 4, 5, 0x5c5862, 8, 2); // bowl
    px(g, 5, 7, 0x47434d, 6, 1);
  };
  const torch: [Texture, Texture] = [
    bake((g) => torchBase(g)),
    bake((g) => {
      torchBase(g);
      px(g, 6, 2, 0xffa040, 4, 3); // flame
      px(g, 7, 1, 0xffd070, 2, 2);
      px(g, 7, 3, 0xfff3b0, 2, 2);
    }),
  ];

  const star = bake((g) => {
    px(g, 7, 5, 0xffe066, 2, 6);
    px(g, 5, 7, 0xffe066, 6, 2);
    px(g, 6, 6, 0xfff3b0, 4, 4);
  });

  const lantern = bake((g) => {
    px(g, 6, 3, 0x6b5446, 4, 1); // handle
    px(g, 5, 4, 0x8b6a4a, 6, 2);
    px(g, 5, 6, 0xf2cc8f, 6, 6); // glass
    px(g, 7, 7, 0xffa040, 2, 3); // flame
    px(g, 5, 12, 0x8b6a4a, 6, 1);
  });

  // White so it can be tinted with each player's color.
  const critter = bake((g) => {
    px(g, 4, 2, 0xffffff, 2, 4); // ears
    px(g, 10, 2, 0xffffff, 2, 4);
    g.roundRect(3, 5, 10, 9, 3).fill(0xffffff);
    px(g, 6, 8, 0x2a1f1a, 1, 2); // eyes
    px(g, 9, 8, 0x2a1f1a, 1, 2);
    px(g, 7, 11, 0x2a1f1a, 2, 1); // little smile
    px(g, 4, 10, 0xffc4b0, 1, 1); // cheeks
    px(g, 11, 10, 0xffc4b0, 1, 1);
  });

  // The critter silhouette as a pixel mask (ears + rounded body), then only its edge pixels.
  const mask = (x: number, y: number): boolean => {
    if ((x === 4 || x === 5 || x === 10 || x === 11) && y >= 2 && y <= 5) return true; // ears
    if (x < 3 || x > 12 || y < 5 || y > 13) return false;
    const cornerX = x < 5 ? 5 - x : x > 10 ? x - 10 : 0;
    const cornerY = y < 7 ? 7 - y : y > 11 ? y - 11 : 0;
    return cornerX + cornerY <= 2; // trims the corners to match the rounded body
  };
  const critterOutline = bake((g) => {
    for (let y = 0; y < SRC; y++)
      for (let x = 0; x < SRC; x++) {
        if (!mask(x, y)) continue;
        const edge = !mask(x - 1, y) || !mask(x + 1, y) || !mask(x, y - 1) || !mask(x, y + 1);
        if (edge) px(g, x, y, 0xffffff);
      }
  });

  const shadow = bake((g) => {
    g.ellipse(8, 14, 6, 2).fill({ color: 0x000000, alpha: 0.3 });
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
    soil,
    hole,
  };
}
