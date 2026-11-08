import type { Action } from './rules';

// ---- Client -> server ----
export type ClientMessage =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'intent'; seq: number; action: Action }
  | { t: 'lantern'; on: boolean };

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
];

export type ServerMessage =
  | { t: 'error'; message: string }
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
    }
  | {
      t: 'tick';
      tick: number;
      /** Your highest resolved intent sequence number. */
      ack: number;
      pos: PlayerPos[];
      /** Flat [index, type, ...] of tiles explored this tick. */
      tiles: number[];
      /** Traps revealed this tick. */
      traps: number[];
      heartCharge: number[];
      open: boolean;
      /** Everyone panicked at once: the run is over. */
      runOver: boolean;
      mirrors: number[];
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
