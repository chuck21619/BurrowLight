import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAction, isCardinal, isTalentId, normalizeCode, sanitizeName, type ClientMessage } from '@burrowlight/shared';
import { EMPTY_ROOM_TTL_MS, Room, makeRoomCode, send } from './room';
import { leaderboardFromEnv, type LeaderboardStore } from './leaderboard';

const MAX_MESSAGES_PER_SECOND = 20;
const KICK_MESSAGES_PER_SECOND = 60;
const MAX_FAILED_JOINS = 10;

const CLIENT_DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export interface RunningServer {
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export function startServer(port: number, leaderboard: LeaderboardStore = leaderboardFromEnv()): Promise<RunningServer> {
  const rooms = new Map<string, Room>();
  const http = createServer((req, res) => serveStatic(req.url ?? '/', res));
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let memberId: string | null = null;
    let windowStart = Date.now();
    let windowCount = 0;
    let failedJoins = 0;
    const peer = { send: (data: string) => ws.readyState === ws.OPEN && ws.send(data) };
    const fail = (message: string) => send(peer, { t: 'error', message });

    ws.on('message', (raw) => {
      // Rate limit: drop past 20/s, disconnect past 60/s.
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > KICK_MESSAGES_PER_SECOND) return ws.close(1008, 'too many messages');
      if (windowCount > MAX_MESSAGES_PER_SECOND) return;

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;

      switch (msg.t) {
        case 'create': {
          if (room) return;
          const code = makeRoomCode((c) => rooms.has(c));
          const devFloor = process.env.NODE_ENV !== 'production' && Number.isInteger(msg.startFloor) ? msg.startFloor! : 1;
          const devSeed = process.env.NODE_ENV !== 'production' && Number.isInteger(msg.seed) && msg.seed! > 0 ? msg.seed! : null;
          const r = new Room(code, Math.min(9, Math.max(1, devFloor)), devSeed, leaderboard);
          rooms.set(code, r);
          const m = r.addMember(peer, sanitizeName(msg.name));
          if (typeof m === 'string') return fail(m);
          room = r;
          memberId = m.id;
          return;
        }
        case 'join': {
          if (room) return;
          const r = rooms.get(normalizeCode(String(msg.code ?? '')));
          if (!r) {
            if (++failedJoins > MAX_FAILED_JOINS) return ws.close(1008, 'too many failed joins');
            return fail('No burrow with that code.');
          }
          if (typeof msg.token === 'string') {
            const back = r.rejoin(peer, msg.token);
            if (back) {
              room = r;
              memberId = back.id;
              return;
            }
          }
          const m = r.addMember(peer, sanitizeName(msg.name));
          if (typeof m === 'string') return fail(m);
          room = r;
          memberId = m.id;
          return;
        }
        case 'ready':
          if (room && memberId) room.setReady(memberId, msg.ready === true);
          return;
        case 'start': {
          if (!room || !memberId) return;
          const err = room.start(memberId);
          if (err) fail(err);
          return;
        }
        case 'gear':
          if (room && memberId) room.setGear(memberId, msg.gear);
          return;
        case 'learn':
          if (room && memberId && isTalentId(msg.talent)) room.learn(memberId, msg.talent);
          return;
        case 'checkDig':
          if (room && memberId && isCardinal(msg.dir)) room.checkDig(memberId, msg.dir);
          return;
        case 'lantern':
          if (room && memberId) room.lantern(memberId, msg.on === true);
          return;
        case 'intent':
          if (room && memberId && Number.isInteger(msg.seq) && isAction(msg.action))
            room.intent(memberId, msg.seq, msg.action);
          return;
      }
    });

    ws.on('close', () => {
      if (room && memberId) {
        room.disconnect(memberId);
        if (room.members.size === 0) {
          room.stop();
          rooms.delete(room.code);
        }
      }
    });
  });

  // Close rooms nobody has been connected to for a while.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      if (r.emptySince !== null && now - r.emptySince > EMPTY_ROOM_TTL_MS) {
        r.stop();
        rooms.delete(code);
      }
    }
  }, 5000);

  return new Promise((resolveStart) => {
    http.listen(port, () => {
      const addr = http.address();
      resolveStart({
        port: typeof addr === 'object' && addr ? addr.port : port,
        rooms,
        close: () => closeAll(http, wss, rooms, sweep),
      });
    });
  });
}

function closeAll(
  http: Server,
  wss: WebSocketServer,
  rooms: Map<string, Room>,
  sweep: ReturnType<typeof setInterval>,
): Promise<void> {
  clearInterval(sweep);
  for (const r of rooms.values()) r.stop();
  for (const c of wss.clients) c.terminate();
  return new Promise((done) => wss.close(() => http.close(() => done())));
}

/** Serves the built client (packages/client/dist) in production. In dev, Vite serves it. */
function serveStatic(url: string, res: import('node:http').ServerResponse): void {
  if (!existsSync(CLIENT_DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Burrowlight server is running. In development, open the Vite client (http://localhost:5173).');
    return;
  }
  const path = normalize(decodeURIComponent(url.split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
  let file = join(CLIENT_DIST, path);
  if (!file.startsWith(CLIENT_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(CLIENT_DIST, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
