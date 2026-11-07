import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DIRS, Tile, checkMove, type ServerMessage } from '@burrowlight/shared';
import { startServer, type RunningServer } from '../src/server';

let server: RunningServer;

beforeEach(async () => {
  server = await startServer(0);
});
afterEach(async () => {
  await server.close();
});

/** A test client that records every message and can wait for one matching a predicate. */
async function connect() {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r) => ws.once('open', r));
  return {
    ws,
    inbox,
    send: (m: object) => ws.send(JSON.stringify(m)),
    waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeout = 2000): Promise<T> {
      const found = inbox.find(pred);
      if (found) return Promise.resolve(found as T);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as T);
          },
        });
      });
    },
  };
}

type Of<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>;
const is =
  <K extends ServerMessage['t']>(t: K, extra: (m: Of<K>) => boolean = () => true) =>
  (m: ServerMessage): m is Of<K> =>
    m.t === t && extra(m as Of<K>);

describe('server', () => {
  it('creates a room, lets a friend join by code, starts, and moves a player on the tick loop', async () => {
    const host = await connect();
    host.send({ t: 'create', name: 'Pip' });
    const lobby = await host.waitFor(is('lobby'));
    expect(lobby.code).toMatch(/^[A-Z]{5}$/);
    expect(lobby.hostId).toBe(lobby.you);

    const friend = await connect();
    friend.send({ t: 'join', code: lobby.code.toLowerCase(), name: 'Moss' });
    await host.waitFor(is('lobby', (m) => m.players.length === 2));

    // Start is refused until everyone is ready.
    host.send({ t: 'start' });
    await host.waitFor(is('error'));

    host.send({ t: 'ready', ready: true });
    friend.send({ t: 'ready', ready: true });
    await host.waitFor(is('lobby', (m) => m.players.every((p) => p.ready)));
    host.send({ t: 'start' });

    const welcome = await host.waitFor(is('welcome'));
    await friend.waitFor(is('welcome'));
    expect(welcome.players.map((p) => p.name).sort()).toEqual(['Moss', 'Pip']);
    expect(welcome.tiles.length).toBeGreaterThan(20);

    // Find a direction the host can step in, using only the tiles the server revealed.
    const known = new Map<number, number>();
    for (let i = 0; i < welcome.tiles.length; i += 2) known.set(welcome.tiles[i]!, welcome.tiles[i + 1]!);
    const me = welcome.pos.find((p) => p[0] === welcome.you)!;
    const tile = (x: number, y: number) => known.get(y * welcome.w + x) ?? Tile.Wall;
    const occupied = (x: number, y: number) => welcome.pos.some((p) => p[1] === x && p[2] === y);
    const dir = (['n', 's', 'e', 'w'] as const).find((d) => checkMove(tile, me[1], me[2], d, occupied) === 'ok')!;

    host.send({ t: 'intent', seq: 1, action: { kind: 'move', dir } });
    const tick = await host.waitFor(is('tick', (m) => m.ack >= 1));
    const after = tick.pos.find((p) => p[0] === welcome.you)!;
    expect([after[1], after[2]]).toEqual([me[1] + DIRS[dir][0], me[2] + DIRS[dir][1]]);
    host.ws.close();
    friend.ws.close();
  });

  it('rejects unknown codes, and new joins once a run has started', async () => {
    const a = await connect();
    a.send({ t: 'join', code: 'ZZZZZ', name: 'X' });
    expect((await a.waitFor(is('error'))).message).toMatch(/No burrow/);

    a.send({ t: 'create', name: 'Solo' });
    const lobby = await a.waitFor(is('lobby'));
    a.send({ t: 'ready', ready: true });
    await a.waitFor(is('lobby', (m) => m.players[0]!.ready));
    a.send({ t: 'start' });
    await a.waitFor(is('welcome'));

    const late = await connect();
    late.send({ t: 'join', code: lobby.code, name: 'Late' });
    expect((await late.waitFor(is('error'))).message).toMatch(/already started/);
    a.ws.close();
    late.ws.close();
  });

  it('lets a disconnected player rejoin their own critter with their token', async () => {
    const a = await connect();
    a.send({ t: 'create', name: 'Pip' });
    const lobby = await a.waitFor(is('lobby'));
    a.send({ t: 'ready', ready: true });
    await a.waitFor(is('lobby', (m) => m.players[0]!.ready));
    a.send({ t: 'start' });
    const welcome = await a.waitFor(is('welcome'));
    a.ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const back = await connect();
    back.send({ t: 'join', code: lobby.code, name: 'Pip', token: welcome.token });
    const again = await back.waitFor(is('welcome'));
    expect(again.you).toBe(welcome.you);
    back.ws.close();
  });
});
