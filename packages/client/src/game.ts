import { Application, Container, Graphics, Sprite, Text, TextureSource } from 'pixi.js';
import {
  ActionCost,
  BEAM_STRENGTH,
  DIRS,
  HEART_FULL,
  LANTERN_RADIUS,
  MAX_QUEUED_INTENTS,
  SUNSHAFT_RADIUS,
  Tile,
  actionCost,
  alliesNeverBlock,
  beamCellOf,
  computeLight,
  traceBeam,
  type Emitter,
  type MirrorOrient,
  hashSeed,
  isDiagonal,
  resolveMove,
  type Action,
  type ClientMessage,
  type Dir,
  type LightMap,
  type LightSource,
  type PlayerInfo,
  type PlayerPos,
  type ServerMessage,
} from '@burrowlight/shared';
import { SRC, makeTextures, type Textures } from './textures';

const SCALE = 3;
const TILE = SRC * SCALE; // 48 px on screen
const UNKNOWN = -1;
/** Explored but unlit: barely there, so the room reads as dark. */
const MEMORY_TINT = 0x231e31;
const DIAGONAL_GRACE_MS = 40;
const SHARE_SPREAD_PX = 20;
const LABEL_STACK_PX = 15;
/** After you toggle your lantern, trust your own toggle over the server for this long. */
const LANTERN_PREDICT_MS = 400;

interface Avatar {
  info: PlayerInfo;
  connected: boolean;
  /** Where the critter should be (server position, or predicted for you). */
  tx: number;
  ty: number;
  /** Where it is drawn right now, sliding toward (tx, ty). */
  dx: number;
  dy: number;
  /** Sideways nudge in pixels so critters sharing a tile don't hide each other. */
  ox: number;
  lit: boolean;
  oil: number;
  ko: number;
  /** 0–100 */
  jitters: number;
  panic: boolean;
  root: Container;
  body: Sprite;
  label: Text;
  stars: Container;
  lamp: Sprite;
}

export interface PartyMember {
  info: PlayerInfo;
  connected: boolean;
  you: boolean;
  lit: boolean;
  oil: number;
  ko: number;
  jitters: number;
  panic: boolean;
}

export interface Objective {
  charged: number;
  total: number;
  open: boolean;
}

interface Heart {
  idx: number;
  charge: number;
  bar: Graphics;
}

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;
type Tick = Extract<ServerMessage, { t: 'tick' }>;

export class GameView {
  private app = new Application();
  private world = new Container();
  private tileLayer = new Container();
  private markerLayer = new Container();
  private entityLayer = new Container();
  private tex!: Textures;
  private ready = false;

  private w = 0;
  private h = 0;
  private tiles = new Int8Array(0);
  private tileSprites: (Sprite | undefined)[] = [];
  private sunshafts: number[] = [];
  private stairsIdx = -1;
  private traps = new Set<number>();
  private trapSprites = new Map<number, Sprite>();
  private hearts: Heart[] = [];
  private open = false;
  private light: LightMap | null = null;
  private lightDirty = true;
  private emitters: Emitter[] = [];
  private mirrors = new Map<number, MirrorOrient>();
  private mirrorSprites = new Map<number, Sprite>();
  private beamGfx = new Graphics();

  private avatars = new Map<string, Avatar>();
  private you = '';
  private tickMs = 100;
  private serverTick = 0;

  // Prediction for your own critter.
  private seq = 0;
  private pending: { seq: number; action: Action }[] = [];
  private serverX = 0;
  private serverY = 0;
  private readyAt = 0;
  private myLit = false;
  private litToggledAt = -Infinity;

  private keys = new Set<string>();
  private lastKeyDown = 0;
  private waitRequested = false;
  private rotateRequested = false;
  /** One buffered key tap, so quick taps (or a tap while busy) are never lost. */
  private tapped: Dir | null = null;

  onPartyChange: (players: PartyMember[]) => void = () => {};
  onObjective: (o: Objective) => void = () => {};
  onRunOver: () => void = () => {};
  onDebug: (text: string) => void = () => {};

  constructor(private send: (msg: ClientMessage) => void) {}

  async mount(host: HTMLElement): Promise<void> {
    if (this.ready) return;
    TextureSource.defaultOptions.scaleMode = 'nearest';
    await this.app.init({ resizeTo: window, background: 0x0b0a10, antialias: false });
    host.appendChild(this.app.canvas);
    this.tex = makeTextures(this.app.renderer);
    this.entityLayer.sortableChildren = true;
    this.world.addChild(this.tileLayer, this.markerLayer, this.entityLayer);
    this.app.stage.addChild(this.world);
    this.app.ticker.add((t) => this.frame(t.deltaMS));
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    this.ready = true;
  }

  // ---------- Server messages ----------

  loadWelcome(msg: Welcome): void {
    this.you = msg.you;
    this.tickMs = msg.tickMs;
    this.serverTick = msg.tick;
    this.w = msg.w;
    this.h = msg.h;
    this.tiles = new Int8Array(this.w * this.h).fill(UNKNOWN);
    for (const layer of [this.tileLayer, this.markerLayer]) layer.removeChildren().forEach((c) => c.destroy());
    this.tileSprites = [];
    this.sunshafts = [];
    this.stairsIdx = -1;
    this.traps.clear();
    this.trapSprites.clear();
    this.mirrorSprites.clear();
    this.mirrors.clear();
    this.emitters = [];
    for (let k = 0; k < msg.emitters.length; k += 3) {
      const i = msg.emitters[k]!;
      this.emitters.push({ x: i % this.w, y: Math.floor(i / this.w), dx: msg.emitters[k + 1]!, dy: msg.emitters[k + 2]! });
    }
    this.beamGfx = new Graphics();
    this.addTiles(msg.tiles);
    for (const t of msg.traps) this.addTrap(t);
    this.setMirrors(msg.mirrors);
    this.markerLayer.addChild(this.beamGfx);

    this.hearts = msg.hearts.map((idx, k) => {
      const bar = new Graphics();
      bar.position.set((idx % this.w) * TILE, Math.floor(idx / this.w) * TILE);
      this.markerLayer.addChild(bar);
      const heart = { idx, charge: msg.heartCharge[k] ?? 0, bar };
      this.drawHeartBar(heart);
      return heart;
    });
    this.setOpen(msg.open);

    for (const a of this.avatars.values()) a.root.destroy({ children: true });
    this.avatars.clear();
    for (const info of msg.players) this.addAvatar(info);

    this.pending = [];
    this.seq = Math.max(this.seq, msg.ack);
    this.readyAt = 0;
    this.litToggledAt = -Infinity;
    this.applyPositions(msg.pos, msg.ack, true);
    this.lightDirty = true;
    this.emitObjective();
    if (msg.runOver) this.onRunOver();
  }

  applyTick(msg: Tick): void {
    this.serverTick = msg.tick;
    this.addTiles(msg.tiles);
    for (const t of msg.traps) this.addTrap(t);
    msg.heartCharge.forEach((c, k) => {
      const heart = this.hearts[k];
      if (heart && heart.charge !== c) {
        heart.charge = c;
        this.drawHeartBar(heart);
      }
    });
    this.setOpen(msg.open);
    this.setMirrors(msg.mirrors);
    this.applyPositions(msg.pos, msg.ack, false);
    this.lightDirty = true;
    this.emitObjective();
    if (msg.runOver) this.onRunOver();
  }

  private setMirrors(flat: number[]): void {
    for (let k = 0; k < flat.length; k += 2) {
      const i = flat[k]!;
      const o = flat[k + 1]! as MirrorOrient;
      let s = this.mirrorSprites.get(i);
      if (!s) {
        s = new Sprite(this.tex.mirror[o]);
        s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
        s.scale.set(SCALE);
        s.visible = false;
        this.mirrorSprites.set(i, s);
        this.markerLayer.addChild(s);
      }
      if (this.mirrors.get(i) !== o) {
        this.mirrors.set(i, o);
        s.texture = this.tex.mirror[o];
        this.lightDirty = true;
      }
    }
  }

  private addTiles(flat: number[]): void {
    for (let k = 0; k < flat.length; k += 2) {
      const i = flat[k]!;
      const type = flat[k + 1]!;
      if (this.tiles[i] !== UNKNOWN) continue;
      this.tiles[i] = type;
      const x = i % this.w;
      const y = (i - x) / this.w;
      const s = new Sprite(this.textureFor(type, x, y));
      s.position.set(x * TILE, y * TILE);
      s.scale.set(SCALE);
      s.tint = MEMORY_TINT;
      this.tileSprites[i] = s;
      this.tileLayer.addChild(s);
      if (type === Tile.Sunshaft) this.sunshafts.push(i);
      if (type === Tile.StairsDown) this.stairsIdx = i;
    }
    if (flat.length) this.lightDirty = true;
  }

  private textureFor(type: number, x: number, y: number) {
    switch (type) {
      case Tile.Wall:
        return this.tex.wall;
      case Tile.StairsDown:
        return this.open ? this.tex.stairs : this.tex.stairsClosed;
      case Tile.Sunshaft:
        return this.tex.sunshaft;
      case Tile.Heartstone:
        return this.tex.heartstone;
      case Tile.Sunbeam:
        return this.tex.sunbeam;
      default:
        return this.tex.floor[hashSeed(x, y) % this.tex.floor.length]!;
    }
  }

  private addTrap(i: number): void {
    if (this.traps.has(i)) return;
    this.traps.add(i);
    const s = new Sprite(this.tex.trap);
    s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
    s.scale.set(SCALE);
    s.visible = false;
    this.trapSprites.set(i, s);
    this.markerLayer.addChildAt(s, 0);
    this.lightDirty = true;
  }

  private setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    const s = this.tileSprites[this.stairsIdx];
    if (s) s.texture = open ? this.tex.stairs : this.tex.stairsClosed;
  }

  /** A small charge bar above each Heartstone, always visible so the party knows where to go. */
  private drawHeartBar(heart: Heart): void {
    const f = heart.charge / HEART_FULL;
    const g = heart.bar;
    g.clear();
    g.roundRect(4, -12, TILE - 8, 8, 3).fill({ color: 0x0b0a10, alpha: 0.8 });
    if (f > 0) g.roundRect(5, -11, (TILE - 10) * f, 6, 2).fill(f >= 1 ? 0xfff07a : 0x9fe3ff);
    g.roundRect(4, -12, TILE - 8, 8, 3).stroke({ color: 0x9fe3ff, width: 1, alpha: 0.7 });
  }

  private applyPositions(pos: PlayerPos[], ack: number, snap: boolean): void {
    const seen = new Set<string>();
    for (const [id, x, y, conn, lit, oil, ko, jitters, panic] of pos) {
      const a = this.avatars.get(id);
      if (!a) continue;
      seen.add(id);
      a.connected = conn === 1;
      a.root.alpha = a.connected ? 1 : 0.5;
      a.lit = lit === 1;
      a.oil = oil;
      a.ko = ko;
      a.stars.visible = ko > 0;
      a.jitters = jitters;
      if (a.panic !== (panic === 1)) {
        a.panic = panic === 1;
        a.label.text = a.panic ? `${a.info.name} !!` : a.info.name;
      }
      if (id === this.you) {
        this.serverX = x;
        this.serverY = y;
        if (snap || performance.now() - this.litToggledAt > LANTERN_PREDICT_MS) this.myLit = a.lit;
        if (oil <= 0 || a.panic) this.myLit = false;
      } else {
        a.tx = x;
        a.ty = y;
      }
      if (snap) {
        a.dx = x;
        a.dy = y;
      }
    }
    for (const [id, a] of this.avatars) {
      if (!seen.has(id)) {
        a.root.destroy({ children: true });
        this.avatars.delete(id);
      }
    }
    this.reconcile(ack);
    this.emitParty();
  }

  /** Drop intents the server has resolved, then replay the rest on top of its position. */
  private reconcile(ack: number): void {
    const me = this.avatars.get(this.you);
    if (!me) return;
    this.pending = this.pending.filter((p) => p.seq > ack);
    if (me.ko > 0 || me.panic) this.pending = []; // the server dropped them
    let x = this.serverX;
    let y = this.serverY;
    for (const { action } of this.pending) {
      if (action.kind !== 'move') continue;
      const dir = resolveMove(this.moveTile, x, y, action.dir, alliesNeverBlock);
      if (dir) {
        x += DIRS[dir][0];
        y += DIRS[dir][1];
      }
    }
    if (x !== me.tx || y !== me.ty) {
      me.tx = x;
      me.ty = y;
      this.lightDirty = true;
    }
  }

  // ---------- Input + prediction ----------

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    if (e.code === 'Space' || e.code === 'KeyF') {
      if (!e.repeat) this.toggleLantern();
      return;
    }
    if (e.code === 'KeyE') {
      if (!e.repeat) this.rotateRequested = true;
      return;
    }
    if (e.code === 'Period' || e.code === 'NumpadDecimal' || e.code === 'Numpad5') {
      this.waitRequested = true;
      return;
    }
    if (!this.keys.has(e.code)) this.lastKeyDown = performance.now();
    this.keys.add(e.code);
    if (!e.repeat) this.tapped = this.heldDir() ?? this.tapped;
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private toggleLantern(): void {
    const me = this.avatars.get(this.you);
    if (!me) return;
    if (me.panic) return;
    const on = !this.myLit;
    if (on && me.oil <= 0) return;
    this.myLit = on;
    this.litToggledAt = performance.now();
    this.send({ t: 'lantern', on });
    this.lightDirty = true;
  }

  private heldDir(): Dir | null {
    const k = this.keys;
    if (k.has('Numpad7')) return 'nw';
    if (k.has('Numpad9')) return 'ne';
    if (k.has('Numpad1')) return 'sw';
    if (k.has('Numpad3')) return 'se';
    const up = k.has('KeyW') || k.has('ArrowUp') || k.has('Numpad8');
    const down = k.has('KeyS') || k.has('ArrowDown') || k.has('Numpad2');
    const left = k.has('KeyA') || k.has('ArrowLeft') || k.has('Numpad4');
    const right = k.has('KeyD') || k.has('ArrowRight') || k.has('Numpad6');
    const v = up === down ? '' : up ? 'n' : 's';
    const hz = left === right ? '' : left ? 'w' : 'e';
    const d = v + hz;
    return d ? (d as Dir) : null;
  }

  private handleInput(now: number): void {
    const me = this.avatars.get(this.you);
    if (!me || me.ko > 0 || me.panic || now < this.readyAt || this.pending.length >= MAX_QUEUED_INTENTS) return;

    let action: Action | null = null;
    let costOf: Action | null = null;
    if (this.rotateRequested) {
      this.rotateRequested = false;
      action = { kind: 'rotate' };
    } else if (this.waitRequested) {
      this.waitRequested = false;
      action = { kind: 'wait' };
    } else {
      const held = this.heldDir();
      const dir = held ?? this.tapped;
      if (!dir) return;
      // While a single key is still held, give a second key a moment to turn it into a diagonal.
      if (held && !isDiagonal(held) && this.pending.length === 0 && now - this.lastKeyDown < DIAGONAL_GRACE_MS) return;
      this.tapped = null;
      const actual = resolveMove(this.moveTile, me.tx, me.ty, dir, alliesNeverBlock);
      if (!actual) return;
      me.tx += DIRS[actual][0];
      me.ty += DIRS[actual][1];
      // Send what was pressed; the server slides it the same way, using the same shared rule.
      action = { kind: 'move', dir };
      costOf = { kind: 'move', dir: actual };
      this.lightDirty = true;
    }

    const seq = ++this.seq;
    this.pending.push({ seq, action });
    this.send({ t: 'intent', seq, action });
    // Keep an exact cadence while a key is held; start fresh after idling.
    const base = now - this.readyAt < 50 ? this.readyAt : now;
    this.readyAt = base + actionCost(costOf ?? action) * this.tickMs;
  }

  /** For light: tiles you haven't seen stop light (you can't light what you don't know). */
  private knownTile = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return Tile.Wall;
    const t = this.tiles[y * this.w + x]!;
    return t === UNKNOWN ? Tile.Wall : t;
  };

  /**
   * For movement: you can feel your way into darkness you haven't seen. If it turns out to be
   * a wall, the server says no and your critter slides back.
   */
  private moveTile = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return Tile.Wall;
    const t = this.tiles[y * this.w + x]!;
    return t === UNKNOWN ? Tile.Floor : t;
  };

  // ---------- Light ----------

  /** The same light rules as the server, run locally so your own lantern moves with you instantly. */
  private refreshLight(): void {
    const sources: LightSource[] = [];
    for (const [id, a] of this.avatars) {
      const lit = id === this.you ? this.myLit && a.oil > 0 : a.lit;
      if (lit) sources.push({ x: a.tx, y: a.ty, radius: LANTERN_RADIUS, strength: 1 });
    }
    for (const i of this.sunshafts) sources.push({ x: i % this.w, y: Math.floor(i / this.w), radius: SUNSHAFT_RADIUS, strength: 1 });

    // Sunbeams, traced locally like the server does. Critters standing in a beam block it.
    const occupied = new Set<number>();
    for (const a of this.avatars.values()) occupied.add(a.ty * this.w + a.tx);
    const beams = this.emitters
      .filter((e) => this.tiles[e.y * this.w + e.x] !== UNKNOWN)
      .map((e) =>
        traceBeam(
          this.w,
          this.h,
          (x, y) => beamCellOf(this.knownTile(x, y)),
          e,
          (i) => this.mirrors.get(i),
          (i) => occupied.has(i),
        ),
      );
    const light = computeLight(this.w, this.h, this.knownTile, sources, beams, BEAM_STRENGTH);
    this.drawBeams(beams);
    for (const [i, s] of this.mirrorSprites) {
      s.visible = this.tiles[i] !== UNKNOWN;
      s.tint = light.glow[i]! > 0 ? lightTint(light.glow[i]!) : MEMORY_TINT;
    }
    this.light = light;
    for (let i = 0; i < this.tileSprites.length; i++) {
      const s = this.tileSprites[i];
      if (s) s.tint = light.glow[i]! > 0 ? lightTint(light.glow[i]!) : MEMORY_TINT;
    }
    for (const [i, s] of this.trapSprites) {
      s.visible = light.level[i]! > 0;
      s.tint = lightTint(light.glow[i]!);
    }
    for (const a of this.avatars.values()) a.lamp.visible = a.info.id === this.you ? this.myLit : a.lit;
    this.lightDirty = false;
  }

  // ---------- Drawing ----------

  /** A glowing line through the centre of every tile a sunbeam crosses. */
  private drawBeams(beams: number[][]): void {
    const g = this.beamGfx;
    g.clear();
    for (const path of beams) {
      if (path.length < 2) continue;
      const pt = (i: number) => [(i % this.w) * TILE + TILE / 2, Math.floor(i / this.w) * TILE + TILE / 2] as const;
      for (const [width, alpha] of [
        [14, 0.18],
        [6, 0.45],
        [2, 0.9],
      ] as const) {
        const [sx, sy] = pt(path[0]!);
        g.moveTo(sx, sy);
        for (const i of path.slice(1)) {
          const [x, y] = pt(i);
          g.lineTo(x, y);
        }
        g.stroke({ color: 0xffe9a0, width, alpha, cap: 'round', join: 'round' });
      }
    }
  }

  private addAvatar(info: PlayerInfo): void {
    const root = new Container();
    const shadow = new Sprite(this.tex.shadow);
    shadow.anchor.set(0.5);
    shadow.scale.set(SCALE);
    const body = new Sprite(this.tex.critter);
    body.anchor.set(0.5);
    body.scale.set(SCALE);
    body.tint = info.color;
    const lamp = new Sprite(this.tex.lantern);
    lamp.anchor.set(0.5);
    lamp.scale.set(2);
    lamp.position.set(TILE * 0.38, 4);
    lamp.visible = false;
    const stars = new Container();
    for (let k = 0; k < 3; k++) {
      const st = new Sprite(this.tex.star);
      st.anchor.set(0.5);
      st.scale.set(1.5);
      stars.addChild(st);
    }
    stars.position.set(0, -TILE * 0.42);
    stars.visible = false;
    const label = new Text({
      text: info.name,
      style: {
        fontFamily: 'Trebuchet MS, sans-serif',
        fontSize: 13,
        fill: 0xfff4e0,
        stroke: { color: 0x0b0a10, width: 3 },
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -TILE * 0.5);
    root.addChild(shadow, body, lamp, stars, label);
    this.entityLayer.addChild(root);
    this.avatars.set(info.id, {
      info,
      connected: true,
      tx: 0,
      ty: 0,
      dx: 0,
      dy: 0,
      ox: 0,
      lit: false,
      oil: 0,
      ko: 0,
      jitters: 0,
      panic: false,
      root,
      body,
      label,
      stars,
      lamp,
    });
  }

  private frame(dtMs: number): void {
    const now = performance.now();
    this.handleInput(now);
    if (this.lightDirty) this.refreshLight();

    // Critters on the same tile stand side by side, sliding apart and back smoothly.
    const sharing = new Map<string, Avatar[]>();
    for (const a of this.avatars.values()) {
      const key = `${a.tx},${a.ty}`;
      sharing.set(key, [...(sharing.get(key) ?? []), a]);
    }
    for (const group of sharing.values()) {
      group.forEach((a, i) => {
        const target = (i - (group.length - 1) / 2) * SHARE_SPREAD_PX;
        a.ox += (target - a.ox) * Math.min(1, dtMs / 80);
        a.label.position.set(-a.ox, -TILE * 0.5 - i * LABEL_STACK_PX - (a.ko > 0 ? 10 : 0));
      });
    }

    // Slide each critter toward its target at about one tile per move, with a little hop.
    const speed = 1.1 / (ActionCost.moveCardinal * this.tickMs); // tiles per ms
    for (const a of this.avatars.values()) {
      const ex = a.tx - a.dx;
      const ey = a.ty - a.dy;
      const dist = Math.hypot(ex, ey);
      if (dist > 3) {
        a.dx = a.tx;
        a.dy = a.ty;
      } else if (dist > 0) {
        const stepLen = Math.min(dist, speed * dtMs);
        a.dx += (ex / dist) * stepLen;
        a.dy += (ey / dist) * stepLen;
      }
      const left = Math.hypot(a.tx - a.dx, a.ty - a.dy);
      const hop = Math.sin(Math.min(left, 1) * Math.PI);
      // The Jitters: critters start trembling past half a meter, and shake hard when they panic.
      const tremble = a.panic ? 3 : a.jitters > 50 ? ((a.jitters - 50) / 50) * 1.5 : 0;
      const shake = tremble ? Math.sin(now / 25 + a.info.color) * tremble : 0;
      a.root.position.set(Math.round(a.dx * TILE + TILE / 2 + a.ox + shake), Math.round(a.dy * TILE + TILE / 2 - hop * 6));
      a.body.scale.set(SCALE * (1 + hop * 0.06), SCALE * (1 - hop * 0.06));
      a.body.rotation = a.ko > 0 ? 0.25 * Math.sin(now / 150) : 0;
      a.root.zIndex = a.dy;
      if (a.ko > 0) {
        // Stars circle the dazed critter's head.
        a.stars.children.forEach((st, k) => {
          const ang = now / 300 + (k * Math.PI * 2) / 3;
          st.position.set(Math.cos(ang) * 14, Math.sin(ang) * 5);
        });
      }
    }

    const me = this.avatars.get(this.you);
    if (me) {
      this.world.position.set(
        Math.round(this.app.screen.width / 2 - (me.dx * TILE + TILE / 2)),
        Math.round(this.app.screen.height / 2 - (me.dy * TILE + TILE / 2)),
      );
    }
    this.onDebug(`tick ${this.serverTick} · pending ${this.pending.length} · ${Math.round(this.app.ticker.FPS)} fps`);
  }

  private emitParty(): void {
    this.onPartyChange(
      [...this.avatars.values()].map((a) => ({
        info: a.info,
        connected: a.connected,
        you: a.info.id === this.you,
        lit: a.info.id === this.you ? this.myLit : a.lit,
        oil: a.oil,
        ko: a.ko,
        jitters: a.jitters,
        panic: a.panic,
      })),
    );
  }

  private emitObjective(): void {
    this.onObjective({
      charged: this.hearts.filter((h) => h.charge >= HEART_FULL).length,
      total: this.hearts.length,
      open: this.open,
    });
  }
}

/** Warm lantern light: dim amber at the edge of a light, cream in the middle, white where lights overlap. */
function lightTint(glow: number): number {
  if (glow <= 0) return MEMORY_TINT;
  const stops: [number, number][] = [
    [0, 0x4a3846],
    [0.6, 0xc9a07a],
    [1, 0xfff0d8],
    [1.6, 0xffffff],
  ];
  for (let k = 1; k < stops.length; k++) {
    const [g1, c1] = stops[k]!;
    const [g0, c0] = stops[k - 1]!;
    if (glow <= g1) return lerpColor(c0, c1, (glow - g0) / (g1 - g0));
  }
  return 0xffffff;
}

function lerpColor(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
