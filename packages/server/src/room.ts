import { randomInt, randomUUID } from 'node:crypto';
import {
  MAX_PLAYERS,
  JITTERS_MAX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TICK_MS,
  allExplored,
  createGame,
  packTiles,
  queueIntent,
  removePlayer,
  setLantern,
  heartIndex,
  packMirrors,
  packEmitters,
  packGloom,
  packTorches,
  packTunnels,
  digVerdict,
  step,
  type Action,
  type GameState,
  type PlayerPos,
  type ServerMessage,
} from '@burrowlight/shared';

/** Anything with send/close: a real WebSocket, or a fake in tests. */
export interface Peer {
  send(data: string): void;
}

export interface Member {
  id: string;
  name: string;
  color: number;
  token: string;
  ready: boolean;
  peer: Peer | null;
  disconnectedAt: number | null;
}

const COLORS = [0xe07a5f, 0x81b29a, 0xf2cc8f, 0x7aa6d6, 0xc39bd3, 0xf4a6b8, 0x9fd4d0, 0xd9a066];
/** How long a dropped player's critter waits for them during a run. */
export const REJOIN_GRACE_MS = 60_000;
/** How long a room with nobody connected is kept. */
export const EMPTY_ROOM_TTL_MS = 5 * 60_000;

export class Room {
  readonly members = new Map<string, Member>();
  phase: 'lobby' | 'playing' = 'lobby';
  hostId = '';
  game: GameState | null = null;
  emptySince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `startFloor` > 1 is for testing on a development server only. */
  constructor(
    readonly code: string,
    private readonly startFloor = 1,
  ) {}

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.peer) n++;
    return n;
  }

  addMember(peer: Peer, name: string): Member | string {
    if (this.phase !== 'lobby') return 'That run has already started.';
    if (this.members.size >= MAX_PLAYERS) return `That burrow is full (${MAX_PLAYERS} players).`;
    const used = new Set([...this.members.values()].map((m) => m.color));
    const member: Member = {
      id: randomUUID().slice(0, 8),
      name,
      color: COLORS.find((c) => !used.has(c)) ?? COLORS[0]!,
      token: randomUUID(),
      ready: false,
      peer,
      disconnectedAt: null,
    };
    this.members.set(member.id, member);
    if (!this.hostId) this.hostId = member.id;
    this.emptySince = null;
    this.broadcastLobby();
    return member;
  }

  /** Reattach a returning player by their rejoin token. */
  rejoin(peer: Peer, token: string): Member | null {
    for (const m of this.members.values()) {
      if (m.token !== token) continue;
      m.peer = peer;
      m.disconnectedAt = null;
      this.emptySince = null;
      if (this.phase === 'playing') this.sendWelcome(m);
      else this.broadcastLobby();
      return m;
    }
    return null;
  }

  disconnect(memberId: string, now = Date.now()): void {
    const m = this.members.get(memberId);
    if (!m) return;
    m.peer = null;
    if (this.phase === 'lobby') {
      this.members.delete(memberId);
      if (this.hostId === memberId) this.hostId = this.members.keys().next().value ?? '';
      this.broadcastLobby();
    } else {
      m.disconnectedAt = now;
    }
    if (this.connectedCount === 0) this.emptySince = now;
  }

  setReady(memberId: string, ready: boolean): void {
    const m = this.members.get(memberId);
    if (!m || this.phase !== 'lobby') return;
    m.ready = ready;
    this.broadcastLobby();
  }

  /** Host starts the run once everyone is ready. Returns an error message or null. */
  start(memberId: string): string | null {
    if (this.phase !== 'lobby') return 'Already started.';
    if (memberId !== this.hostId) return 'Only the host can start.';
    if (![...this.members.values()].every((m) => m.ready)) return 'Everyone needs to be ready.';
    this.phase = 'playing';
    const seed = randomInt(1, 2 ** 31);
    this.game = createGame(
      seed,
      [...this.members.values()].map((m) => ({ id: m.id, name: m.name, color: m.color })),
      this.startFloor,
    );
    for (const m of this.members.values()) this.sendWelcome(m);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return null;
  }

  intent(memberId: string, seq: number, action: Action): void {
    if (this.game) queueIntent(this.game, memberId, seq, action);
  }

  checkDig(memberId: string, dir: 'n' | 's' | 'e' | 'w'): void {
    const m = this.members.get(memberId);
    if (!this.game || !m?.peer) return;
    const v = digVerdict(this.game, memberId, dir);
    send(m.peer, { t: 'digCheck', dir, ok: v.ok, reason: v.reason });
  }

  lantern(memberId: string, on: boolean): void {
    if (this.game) setLantern(this.game, memberId, on);
  }

  /** One server tick: simulate, then send each player what changed. */
  tick(now = Date.now()): void {
    const game = this.game;
    if (!game) return;
    // Drop players who have been gone longer than the grace period.
    for (const m of [...this.members.values()]) {
      if (m.disconnectedAt !== null && now - m.disconnectedAt > REJOIN_GRACE_MS) {
        removePlayer(game, m.id);
        this.members.delete(m.id);
      }
    }
    step(game, { isPresent: (id) => this.members.get(id)?.peer != null });
    if (game.descended) {
      // New floor: everyone gets a full snapshot.
      for (const m of this.members.values()) this.sendWelcome(m);
      return;
    }
    const pos = this.positions();
    const tiles = packTiles(game, game.newlyExplored);
    const heartCharge = game.hearts.map((h) => Math.round(h.charge * 10) / 10);
    const mirrors = packMirrors(game);
    for (const m of this.members.values()) {
      const p = game.players.get(m.id);
      if (!m.peer || !p) continue;
      send(m.peer, {
        t: 'tick',
        tick: game.tick,
        ack: p.lastAck,
        pos,
        tiles,
        traps: game.newlyRevealed,
        heartCharge,
        open: game.exitOpen,
        runOver: game.runOver,
        mirrors,
        gloom: packGloom(game),
        torches: packTorches(game),
        intro: Math.max(0, game.introUntil - game.tick),
        tunnels: packTunnels(game),
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private positions(): PlayerPos[] {
    const out: PlayerPos[] = [];
    for (const p of this.game!.players.values()) {
      const m = this.members.get(p.id);
      const game = this.game!;
      out.push([
        p.id,
        p.x,
        p.y,
        m?.peer ? 1 : 0,
        p.lit ? 1 : 0,
        p.oil,
        Math.max(0, p.koUntil - game.tick),
        Math.round((p.jitters / JITTERS_MAX) * 100),
        p.panic ? 1 : 0,
        p.digging ? Math.max(0, p.digging.until - game.tick) : 0,
        p.braces,
      ]);
    }
    return out;
  }

  private sendWelcome(m: Member): void {
    const game = this.game;
    if (!game || !m.peer) return;
    send(m.peer, {
      t: 'welcome',
      code: this.code,
      you: m.id,
      token: m.token,
      tick: game.tick,
      tickMs: TICK_MS,
      floor: game.floor,
      w: game.map.w,
      h: game.map.h,
      players: [...game.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })),
      pos: this.positions(),
      tiles: packTiles(game, allExplored(game)),
      ack: game.players.get(m.id)?.lastAck ?? 0,
      hearts: game.hearts.map((h) => heartIndex(game, h)),
      heartCharge: game.hearts.map((h) => Math.round(h.charge * 10) / 10),
      traps: [...game.revealedTraps],
      open: game.exitOpen,
      runOver: game.runOver,
      emitters: packEmitters(game),
      mirrors: packMirrors(game),
      heartMax: game.hearts.map((h) => h.max),
      gloom: packGloom(game),
      torches: packTorches(game),
      intro: Math.max(0, game.introUntil - game.tick),
      tunnels: packTunnels(game),
    });
  }

  broadcastLobby(): void {
    const players = [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      ready: m.ready,
      connected: m.peer !== null,
    }));
    for (const m of this.members.values()) {
      if (m.peer)
        send(m.peer, { t: 'lobby', code: this.code, you: m.id, token: m.token, hostId: this.hostId, players });
    }
  }
}

export function send(peer: Peer, msg: ServerMessage): void {
  peer.send(JSON.stringify(msg));
}

export function makeRoomCode(taken: (code: string) => boolean): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
}
