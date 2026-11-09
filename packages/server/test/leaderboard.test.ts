import { afterEach, describe, expect, it, vi } from 'vitest';
import { gistLeaderboard, memoryLeaderboard } from '../src/leaderboard';

const run = (seconds: number) => ({ seconds, names: ['Moss'], date: '2026-11-09' });

describe('leaderboard stores', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('in memory: ranks runs', async () => {
    const store = memoryLeaderboard();
    expect((await store.submit(run(600))).rank).toBe(1);
    expect((await store.submit(run(300))).rank).toBe(1);
    expect((await store.top()).map((e) => e.seconds)).toEqual([300, 600]);
  });

  it('in a gist: loads the board once, saves a run that places, skips one that does not', async () => {
    let saved = JSON.stringify(Array.from({ length: 10 }, (_, k) => run(100 + k)));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        calls.push(init?.method ?? 'GET');
        if (init?.method === 'PATCH') saved = JSON.parse(init.body!).files['burrowlight-leaderboard.json'].content;
        return { ok: true, status: 200, json: async () => ({ files: { 'burrowlight-leaderboard.json': { content: saved } } }) };
      }),
    );
    const store = gistLeaderboard('abc', 'token');
    expect((await store.submit(run(5000))).rank).toBeNull(); // too slow: nothing written
    expect((await store.submit(run(50))).rank).toBe(1);
    expect(calls).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(saved)[0].seconds).toBe(50);
  });
});
