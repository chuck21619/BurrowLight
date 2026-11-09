/**
 * Talents v1: four trees, each a root that unlocks two branches. Earned during a run (1 point per
 * floor the party goes down) and lost when it ends.
 */
export type TreeId = 'light' | 'burrow' | 'tinker' | 'kindle';

export type TalentId =
  | 'brightWick'
  | 'thriftyWick'
  | 'prism'
  | 'deepPockets'
  | 'quickPaws'
  | 'stonebreaker'
  | 'disarm'
  | 'trapSense'
  | 'mirrorPack'
  | 'mend'
  | 'shareFlame'
  | 'soothe';

export interface TalentDef {
  id: TalentId;
  tree: TreeId;
  name: string;
  /** One line shown in the talent menu. */
  text: string;
  /** The root of its tree (null for roots). */
  requires: TalentId | null;
}

export const TREES: { id: TreeId; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'burrow', name: 'Burrowing' },
  { id: 'tinker', name: 'Tinker' },
  { id: 'kindle', name: 'Kindle' },
];

export const TALENTS: TalentDef[] = [
  { id: 'brightWick', tree: 'light', name: 'Bright Wick', text: 'Your lantern lights 6 tiles instead of 4.', requires: null },
  { id: 'thriftyWick', tree: 'light', name: 'Thrifty Wick', text: 'Your lantern burns oil half as fast.', requires: 'brightWick' },
  {
    id: 'prism',
    tree: 'light',
    name: 'Prism',
    text: 'Standing in a sunbeam splits it into two beams at right angles.',
    requires: 'brightWick',
  },
  { id: 'deepPockets', tree: 'burrow', name: 'Deep Pockets', text: 'Carry one more burrow brace on every floor.', requires: null },
  { id: 'quickPaws', tree: 'burrow', name: 'Quick Paws', text: 'Dig a tunnel in 1 second instead of 3.', requires: 'deepPockets' },
  {
    id: 'stonebreaker',
    tree: 'burrow',
    name: 'Stonebreaker',
    text: 'Dig from or into paved stone floors.',
    requires: 'deepPockets',
  },
  { id: 'disarm', tree: 'tinker', name: 'Disarm', text: 'Press E next to a trap you can see to remove it.', requires: null },
  { id: 'trapSense', tree: 'tinker', name: 'Trap Sense', text: 'Traps within 2 tiles show up, even in the dark.', requires: 'disarm' },
  {
    id: 'mirrorPack',
    tree: 'tinker',
    name: 'Mirror Pack',
    text: 'Carry a mirror: press R to set it down on empty floor or pick it back up.',
    requires: 'disarm',
  },
  { id: 'mend', tree: 'kindle', name: 'Mend', text: 'Press E next to a dazed friend to wake them at once.', requires: null },
  {
    id: 'shareFlame',
    tree: 'kindle',
    name: 'Share the Flame',
    text: 'Press E next to a friend to give them 15 seconds of your oil.',
    requires: 'mend',
  },
  {
    id: 'soothe',
    tree: 'kindle',
    name: 'Soothe',
    text: 'Friends within 2 tiles of you fill the Jitters at half speed, even alone.',
    requires: 'mend',
  },
];

export const talentDef = (id: string): TalentDef | undefined => TALENTS.find((t) => t.id === id);
export const isTalentId = (id: unknown): id is TalentId => typeof id === 'string' && TALENTS.some((t) => t.id === id);

/** Can a critter with these talents (and points) learn `id` now? Null if yes, or the reason why not. */
export function learnProblem(known: ReadonlySet<string>, points: number, id: TalentId): string | null {
  const def = talentDef(id)!;
  if (known.has(id)) return 'Already learned';
  if (points <= 0) return 'No talent points';
  if (def.requires && !known.has(def.requires)) return `Needs ${talentDef(def.requires)!.name} first`;
  return null;
}

// ---- Effect numbers ----
export const BRIGHT_WICK_RADIUS = 6;
export const QUICK_PAWS_DIG_TICKS = 10;
/** Share the Flame gives this much oil (15 s). */
export const SHARE_FLAME_OIL = 150;
export const TRAP_SENSE_RADIUS = 2;
export const SOOTHE_RADIUS = 2;
