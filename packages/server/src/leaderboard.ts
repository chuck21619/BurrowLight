import { isEntry, placeRun, type LeaderboardEntry } from '@burrowlight/shared';

/**
 * Where the speedrun board lives. With GIST_ID and GITHUB_TOKEN set (on Render), it's saved in a
 * GitHub Gist, so it survives restarts and redeploys. Without them (development, tests) it lives
 * in memory only.
 */
export interface LeaderboardStore {
  top(): Promise<LeaderboardEntry[]>;
  submit(entry: LeaderboardEntry): Promise<{ board: LeaderboardEntry[]; rank: number | null }>;
}

export function memoryLeaderboard(): LeaderboardStore {
  let board: LeaderboardEntry[] = [];
  return {
    top: async () => board,
    submit: async (entry) => {
      const placed = placeRun(board, entry);
      board = placed.board;
      return placed;
    },
  };
}

const FILE = 'burrowlight-leaderboard.json';

export function gistLeaderboard(gistId: string, token: string): LeaderboardStore {
  const url = `https://api.github.com/gists/${encodeURIComponent(gistId)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'burrowlight-server',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let cache: LeaderboardEntry[] | null = null;
  // One write at a time, in order (this server is the only writer).
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<LeaderboardEntry[]> => {
    if (cache) return cache;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const gist = (await res.json()) as { files?: Record<string, { content?: string }> };
      const raw = JSON.parse(gist.files?.[FILE]?.content ?? '[]') as unknown;
      cache = Array.isArray(raw) ? raw.filter(isEntry) : [];
    } catch (err) {
      console.error('Could not load the leaderboard gist:', (err as Error).message);
      return []; // try again next time
    }
    return cache;
  };

  return {
    top: load,
    submit: (entry) => {
      const job = queue.then(async () => {
        const placed = placeRun(await load(), entry);
        cache = placed.board;
        if (placed.rank !== null) {
          try {
            const res = await fetch(url, {
              method: 'PATCH',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(placed.board, null, 2) } } }),
            });
            if (!res.ok) throw new Error(`GitHub said ${res.status}`);
          } catch (err) {
            console.error('Could not save the leaderboard gist:', (err as Error).message);
          }
        }
        return placed;
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}

export function leaderboardFromEnv(env = process.env): LeaderboardStore {
  if (env.GIST_ID && env.GITHUB_TOKEN) {
    console.log('Leaderboard: saved in GitHub Gist', env.GIST_ID);
    return gistLeaderboard(env.GIST_ID, env.GITHUB_TOKEN);
  }
  console.log('Leaderboard: in memory (set GIST_ID and GITHUB_TOKEN to keep it)');
  return memoryLeaderboard();
}
