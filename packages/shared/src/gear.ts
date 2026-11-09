/**
 * Gear: kept between runs (saved in the player's browser), worn in three slots. Every piece is a
 * sidegrade with a cost, and each is unlocked by an achievement that uses its own mechanic.
 */
export type GearSlot = 'head' | 'shirt' | 'pants';
export type GearId = 'candleCrown' | 'owlGoggles' | 'mirrorVest' | 'cozySweater' | 'diggingDungarees' | 'lanternBelt';

/** Something that happened to a critter that counts toward an achievement. */
export type Feat =
  /** Stepped on a trap. */
  | 'trap'
  /** Dug a tunnel. */
  | 'tunnel'
  /** Calmed down after panicking. */
  | 'calm'
  /** Was there when a Heartstone filled while lit by 3 or more lights at once. */
  | 'bright'
  /** Was there when a Heartstone filled with a sunbeam on it. */
  | 'sunfill'
  /** Went down a floor with under 5 s of oil left. */
  | 'lowOil'
  /** Won a run. */
  | 'win';

export interface GearDef {
  id: GearId;
  slot: GearSlot;
  name: string;
  /** What it does, good and bad. */
  text: string;
  /** How to unlock it. */
  unlock: string;
  /** The feat it counts, and how many times. */
  feat: Feat;
  needs: number;
}

export const GEAR: GearDef[] = [
  {
    id: 'candleCrown',
    slot: 'head',
    name: 'Candle Crown',
    text: 'Your lantern lights 1 tile further, but burns oil half again as fast.',
    unlock: 'Be there when a Heartstone fills with 3 or more lights on it at once.',
    feat: 'bright',
    needs: 1,
  },
  {
    id: 'owlGoggles',
    slot: 'head',
    name: 'Owl Goggles',
    text: 'Traps right next to you show up even in the dark, but your lantern lights 1 tile less.',
    unlock: 'Step on 5 traps (ouch).',
    feat: 'trap',
    needs: 5,
  },
  {
    id: 'mirrorVest',
    slot: 'shirt',
    name: 'Mirror Vest',
    text: 'Sunbeams bounce off you like a mirror instead of stopping. Press E (with nothing else to do) to turn.',
    unlock: 'Be there when a sunbeam fills a Heartstone.',
    feat: 'sunfill',
    needs: 1,
  },
  {
    id: 'cozySweater',
    slot: 'shirt',
    name: 'Cozy Sweater',
    text: 'The Jitters fill half as fast for you, but your lantern lights 1 tile less.',
    unlock: 'Calm down after panicking 3 times.',
    feat: 'calm',
    needs: 3,
  },
  {
    id: 'diggingDungarees',
    slot: 'pants',
    name: 'Digging Dungarees',
    text: 'One more burrow brace on every floor, but digging takes 4 seconds instead of 3.',
    unlock: 'Dig 8 tunnels.',
    feat: 'tunnel',
    needs: 8,
  },
  {
    id: 'lanternBelt',
    slot: 'pants',
    name: 'Lantern Belt',
    text: 'Carry 30 s more oil on every floor, but traps daze you for 15 s instead of 10.',
    unlock: 'Go down a floor with less than 5 seconds of oil left.',
    feat: 'lowOil',
    needs: 1,
  },
];

export type Loadout = Partial<Record<GearSlot, GearId>>;

export const gearDef = (id: string): GearDef | undefined => GEAR.find((g) => g.id === id);

/** Keep only real gear, each in its own slot. */
export function cleanLoadout(raw: unknown): Loadout {
  const out: Loadout = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const slot of ['head', 'shirt', 'pants'] as GearSlot[]) {
    const id = (raw as Record<string, unknown>)[slot];
    const def = typeof id === 'string' ? gearDef(id) : undefined;
    if (def && def.slot === slot) out[slot] = def.id;
  }
  return out;
}

// ---- Effect numbers ----
export const CANDLE_CROWN_EXTRA_RADIUS = 1;
export const DUNGAREES_DIG_TICKS = 40;
export const LANTERN_BELT_OIL = 300;
export const LANTERN_BELT_KO_TICKS = 150;
