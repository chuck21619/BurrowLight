import type { Action } from './rules';
import type { RunSummary } from './sim';
import type { TalentId } from './talents';

// ---- Client -> server ----
export type ClientMessage =
  /** `startFloor` and `seed` are honoured only by a development server, for testing later floors. */
  | { t: 'create'; name: string; startFloor?: number; seed?: number }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'intent'; seq: number; action: Action }
  | { t: 'lantern'; on: boolean }
  /** Ask whether a dig in `dir` would work, before asking the player to spend a brace. */
  | { t: 'checkDig'; dir: 'n' | 's' | 'e' | 'w' }
  /** Spend a talent point. */
  | { t: 'learn'; talent: TalentId };

/** Each critter's talents: [id, talents learned, unspent points, carrying a Mirror Pack mirror]. */
export type PartyTalents = [id: string, talents: TalentId[], points: number, mirror: 0 | 1][];

// ---- Server -> client ----
export interface LobbyPlayer {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
}

/**
 * Per-tick player state. `ko` = ticks left seeing stars (0 = awake);
 * `jitters` = 0–100 (% of the meter); `panic` = 1 while panicking.
 */
export type PlayerPos = [
  id: string,
  x: number,
  y: number,
  connected: 0 | 1,
  lit: 0 | 1,
  oil: number,
  ko: number,
  jitters: number,
  panic: 0 | 1,
  /** Ticks left digging a tunnel (0 = not digging). */
  dig: number,
  /** Burrow braces left on this floor (each digs one tunnel). */
  braces: number,
];

export type ServerMessage =
  | { t: 'error'; message: string }
  /** The answer to `checkDig`: `reason` explains a no. */
  | { t: 'digCheck'; dir: 'n' | 's' | 'e' | 'w'; ok: boolean; reason: string }
  | { t: 'lobby'; code: string; you: string; token: string; hostId: string; players: LobbyPlayer[] }
  | {
      t: 'welcome';
      code: string;
      you: string;
      token: string;
      tick: number;
      tickMs: number;
      floor: number;
      w: number;
      h: number;
      players: PlayerInfo[];
      pos: PlayerPos[];
      /** Flat [index, type, ...] of every tile the party has explored. */
      tiles: number[];
      ack: number;
      /** Tile index of each Heartstone (objectives are always known), and its charge. */
      hearts: number[];
      heartCharge: number[];
      /** Trap tile indices the party has seen so far. */
      traps: number[];
      open: boolean;
      runOver: boolean;
      /** Flat [index, dx, dy, ...] of every sunbeam emitter (drawn once its tile is seen). */
      emitters: number[];
      /** Flat [index, orientation, ...] of every mirror (drawn once its tile is seen). */
      mirrors: number[];
      /** Charge each Heartstone needs (a Great Heartstone needs more). */
      heartMax: number[];
      /** [x, y, pinned, dx, dy, restless, touching] or null. */
      gloom: number[] | null;
      /** Flat [index, lit, ...] of every torch (drawn once seen, or while lit). */
      torches: number[];
      /** Ticks left in a boss introduction (nobody can act). */
      intro: number;
      /** Every critter's tunnel: [endA, endB, ownerId]. */
      tunnels: [number, number, string][];
      /** Set once the run has ended (won or lost). */
      summary: RunSummary | null;
      party: PartyTalents;
      /** Pen doors: flat [door, plate, gem, gemCharge 0–100, open, ...] (-1 = none). */
      locks: number[];
    }
  | {
      t: 'tick';
      tick: number;
      /** Your highest resolved intent sequence number. */
      ack: number;
      pos: PlayerPos[];
      /** Flat [index, type, ...] of tiles explored this tick. */
      tiles: number[];
      /** Every trap the party can see right now (disarmed ones drop off). */
      traps: number[];
      heartCharge: number[];
      open: boolean;
      /** Everyone panicked at once: the run is over. */
      runOver: boolean;
      mirrors: number[];
      gloom: number[] | null;
      torches: number[];
      intro: number;
      tunnels: [number, number, string][];
      summary: RunSummary | null;
      party: PartyTalents;
      locks: number[];
    };

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPRSTUVWXY'; // no I, L, O, Q, Z
export const ROOM_CODE_LENGTH = 5;
export const MAX_NAME_LENGTH = 16;

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

export function sanitizeName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _'-]/gu, '').trim() : '';
  return s.slice(0, MAX_NAME_LENGTH) || 'Critter';
}
