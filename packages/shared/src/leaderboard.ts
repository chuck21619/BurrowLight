/** Speedrun leaderboard: the fastest winning runs (floor 1 to the end of floor 9), by game time. */
export interface LeaderboardEntry {
  /** Game time in seconds (server ticks, so a slow connection doesn't count against you). */
  seconds: number;
  /** The party's critter names. */
  names: string[];
  /** Day of the run, YYYY-MM-DD. */
  date: string;
}

export const LEADERBOARD_SIZE = 10;

export function isEntry(e: unknown): e is LeaderboardEntry {
  const o = e as LeaderboardEntry;
  return (
    typeof o === 'object' &&
    o !== null &&
    Number.isFinite(o.seconds) &&
    o.seconds > 0 &&
    Array.isArray(o.names) &&
    o.names.every((n) => typeof n === 'string') &&
    typeof o.date === 'string'
  );
}

/** Add a run to the board: the board stays sorted and at most 10 long. Rank is 1-based, or null if it didn't make it. */
export function placeRun(
  board: LeaderboardEntry[],
  entry: LeaderboardEntry,
  size = LEADERBOARD_SIZE,
): { board: LeaderboardEntry[]; rank: number | null } {
  const next = [...board.filter(isEntry), entry].sort((a, b) => a.seconds - b.seconds).slice(0, size);
  const at = next.indexOf(entry);
  return { board: next, rank: at >= 0 ? at + 1 : null };
}

/** "12:05" */
export const formatRunTime = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
