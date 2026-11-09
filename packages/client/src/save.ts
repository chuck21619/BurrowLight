import { GEAR, cleanLoadout, type Feat, type GearDef, type GearId, type Loadout } from '@burrowlight/shared';

/** What this browser remembers between runs: achievement counts, unlocked gear, and what you last wore. */
interface Save {
  counts: Partial<Record<Feat, number>>;
  unlocked: GearId[];
  wearing: Loadout;
  /** Tips this player has already had. */
  tipsSeen: string[];
  tipsOn: boolean;
  muted: boolean;
}

const KEY = 'burrowlight.save.v1';

function load(): Save {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Save>;
    return {
      counts: typeof raw.counts === 'object' && raw.counts ? raw.counts : {},
      unlocked: Array.isArray(raw.unlocked) ? raw.unlocked.filter((id) => GEAR.some((g) => g.id === id)) : [],
      wearing: cleanLoadout(raw.wearing),
      tipsSeen: Array.isArray(raw.tipsSeen) ? raw.tipsSeen.filter((t) => typeof t === 'string') : [],
      tipsOn: raw.tipsOn !== false,
      muted: raw.muted === true,
    };
  } catch {
    return { counts: {}, unlocked: [], wearing: {}, tipsSeen: [], tipsOn: true, muted: false };
  }
}

let save = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    // Private window or storage blocked: progress just isn't kept.
  }
}

export const unlocked = (id: GearId): boolean => save.unlocked.includes(id);
export const wearing = (): Loadout => {
  const w: Loadout = {};
  for (const [slot, id] of Object.entries(save.wearing)) if (id && unlocked(id)) w[slot as keyof Loadout] = id;
  return w;
};
export const progress = (g: GearDef): number => Math.min(g.needs, save.counts[g.feat] ?? 0);

export function setWearing(w: Loadout): void {
  save.wearing = cleanLoadout(w);
  persist();
}

/** Count achievement events; returns any gear they just unlocked. */
export function recordFeats(feats: string[]): GearDef[] {
  if (!feats.length) return [];
  save = load(); // another tab may have saved meanwhile
  for (const f of feats) save.counts[f as Feat] = (save.counts[f as Feat] ?? 0) + 1;
  const fresh = GEAR.filter((g) => !save.unlocked.includes(g.id) && (save.counts[g.feat] ?? 0) >= g.needs);
  save.unlocked.push(...fresh.map((g) => g.id));
  persist();
  return fresh;
}

export const tipsSeen = (): string[] => save.tipsSeen;
export const tipsOn = (): boolean => save.tipsOn;
export const muted = (): boolean => save.muted;

export function markTipSeen(id: string): void {
  save = load();
  if (!save.tipsSeen.includes(id)) save.tipsSeen.push(id);
  persist();
}

export function setTipsOn(on: boolean): void {
  save = load();
  save.tipsOn = on;
  if (on) save.tipsSeen = []; // turning tips back on shows them all again
  persist();
}

export function setMuted(m: boolean): void {
  save = load();
  save.muted = m;
  persist();
}
