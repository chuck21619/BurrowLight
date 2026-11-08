import { Application, Container, Graphics, Sprite, Text, TextureSource } from 'pixi.js';
import {
  ActionCost,
  BEAM_STRENGTH,
  DIRS,
  gloomFootprint,
  LANTERN_RADIUS,
  MAX_QUEUED_INTENTS,
  SUNSHAFT_RADIUS,
  TORCH_RADIUS,
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
/** In the dark, another critter shows (as an outline) only within this many tiles of you. */
const SEE_FRIEND_IN_DARK = 2;
/** Every critter's outline in the dark is the same dark purple, not its own color. */
const DARK_OUTLINE = 0x7a5cb8;
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
  /** Silhouette edge shown instead of the body when the critter stands in the dark. */
  outline: Sprite;
  shadow: Sprite;
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
  /** On a boss floor: is the Gloom here, and is it pinned? */
  gloom: boolean;
  pinned: boolean;
  /** The boss introduction is playing. */
  intro: boolean;
}

interface Heart {
  idx: number;
  charge: number;
  max: number;
  bar: Graphics;
}

interface Gloom {
  x: number;
  y: number;
  pinned: boolean;
  dx: number;
  dy: number;
  restless: number;
  touching: boolean;
  /** Drawn position (tiles), sliding toward (x, y). */
  sx: number;
  sy: number;
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
  private gloom: Gloom | null = null;
  private torches = new Map<number, boolean>();
  private torchSprites = new Map<number, Sprite>();
  /** Ticks left in a boss intro (input is ignored and the camera watches the Gloom). */
  private intro = 0;
  private camX = 0;
  private camY = 0;
  private gloomView: Container | null = null;
  private gloomEyes = new Graphics();
  private tether = new Graphics();

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
    this.torchSprites.clear();
    this.torches.clear();
    this.emitters = [];
    for (let k = 0; k < msg.emitters.length; k += 3) {
      const i = msg.emitters[k]!;
      this.emitters.push({ x: i % this.w, y: Math.floor(i / this.w), dx: msg.emitters[k + 1]!, dy: msg.emitters[k + 2]! });
    }
    this.beamGfx = new Graphics();
    this.addTiles(msg.tiles);
    for (const t of msg.traps) this.addTrap(t);
    this.setMirrors(msg.mirrors);
    this.setTorches(msg.torches);
    this.intro = msg.intro;
    this.markerLayer.addChild(this.beamGfx);

    this.hearts = msg.hearts.map((idx, k) => {
      const bar = new Graphics();
      bar.position.set((idx % this.w) * TILE, Math.floor(idx / this.w) * TILE);
      this.markerLayer.addChild(bar);
      const heart = { idx, charge: msg.heartCharge[k] ?? 0, max: msg.heartMax[k] ?? 60, bar };
      this.drawHeartBar(heart);
      return heart;
    });
    this.setOpen(msg.open);
    this.tether = new Graphics();
    this.markerLayer.addChild(this.tether);
    this.gloomView?.destroy({ children: true });
    this.gloomView = null;
    this.gloom = null;
    this.setGloom(msg.gloom, true);

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
    this.setTorches(msg.torches);
    this.intro = msg.intro;
    this.setGloom(msg.gloom, false);
    this.applyPositions(msg.pos, msg.ack, false);
    this.lightDirty = true;
    this.emitObjective();
    if (msg.runOver) this.onRunOver();
  }

  private setGloom(packed: number[] | null, snap: boolean): void {
    if (!packed) {
      if (this.gloomView) {
        this.gloomView.destroy({ children: true });
        this.gloomView = null;
      }
      this.gloom = null;
      return;
    }
    const [x, y, pinned, dx, dy, restless, touching] = packed as [number, number, number, number, number, number, number];
    const prev = this.gloom;
    this.gloom = {
      x,
      y,
      pinned: pinned === 1,
      dx,
      dy,
      restless,
      touching: touching === 1,
      sx: snap || !prev ? x : prev.sx,
      sy: snap || !prev ? y : prev.sy,
    };
    if (!this.gloomView) this.gloomView = this.makeGloomView();
    if (!prev || prev.pinned !== this.gloom.pinned || prev.dx !== dx || prev.dy !== dy) this.drawGloomEyes();
    this.lightDirty = true;
  }

  /** A soft cloud of grumpy darkness with two sleepy eyes. */
  private makeGloomView(): Container {
    const c = new Container();
    const body = new Graphics();
    body.circle(0, 0, 50).fill({ color: 0x3a2a52, alpha: 0.25 });
    for (const [bx, by, r] of [
      [0, 0, 40],
      [-26, -16, 22],
      [26, -16, 22],
      [-22, 22, 24],
      [22, 22, 24],
      [0, -30, 22],
    ] as const)
      body.circle(bx, by, r).fill({ color: 0x241a33, alpha: 0.92 });
    this.gloomEyes = new Graphics();
    c.addChild(body, this.gloomEyes);
    this.entityLayer.addChild(c);
    return c;
  }

  private drawGloomEyes(): void {
    const g = this.gloom;
    if (!g) return;
    const e = this.gloomEyes;
    e.clear();
    for (const side of [-1, 1]) {
      const ex = side * 14;
      if (g.pinned) {
        // Squinting in the sunlight.
        e.roundRect(ex - 8, -8, 16, 3, 1.5).fill(0xf3eefc);
      } else {
        e.ellipse(ex, -6, 7, 9).fill(0xf3eefc);
        e.circle(ex + g.dx * 3, -6 + g.dy * 4, 3).fill(0x120c1c);
      }
    }
  }

  private setTorches(flat: number[]): void {
    for (let k = 0; k < flat.length; k += 2) {
      const i = flat[k]!;
      const on = flat[k + 1] === 1;
      let s = this.torchSprites.get(i);
      if (!s) {
        s = new Sprite(this.tex.torch[on ? 1 : 0]);
        s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
        s.scale.set(SCALE);
        s.visible = false;
        this.torchSprites.set(i, s);
        this.markerLayer.addChild(s);
      }
      if (this.torches.get(i) !== on) {
        this.torches.set(i, on);
        s.texture = this.tex.torch[on ? 1 : 0];
        this.lightDirty = true;
      }
    }
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
    const f = heart.charge / heart.max;
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
    if (me.panic || this.intro > 0) return;
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
    if (!me || me.ko > 0 || me.panic || this.intro > 0 || now < this.readyAt || this.pending.length >= MAX_QUEUED_INTENTS) return;

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
    for (const [i, on] of this.torches) if (on) sources.push({ x: i % this.w, y: Math.floor(i / this.w), radius: TORCH_RADIUS, strength: 1 });

    // Sunbeams, traced locally like the server does. Critters standing in a beam block it.
    const occupied = new Set<number>();
    for (const a of this.avatars.values()) occupied.add(a.ty * this.w + a.tx);
    if (this.gloom) for (const i of gloomFootprint(this.w, this.gloom.x, this.gloom.y)) occupied.add(i);
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
    for (const [i, s] of this.torchSprites) {
      s.visible = this.tiles[i] !== UNKNOWN || this.torches.get(i) === true;
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
    const outline = new Sprite(this.tex.critterOutline);
    outline.anchor.set(0.5);
    outline.scale.set(SCALE);
    outline.tint = DARK_OUTLINE;
    outline.alpha = 0.85;
    outline.visible = false;
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
    root.addChild(shadow, body, outline, lamp, stars, label);
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
      outline,
      shadow,
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
      a.outline.scale.copyFrom(a.body.scale);
      a.outline.rotation = a.body.rotation;
      a.root.zIndex = a.dy;
      this.applyDarkness(a);
      if (a.ko > 0) {
        // Stars circle the dazed critter's head.
        a.stars.children.forEach((st, k) => {
          const ang = now / 300 + (k * Math.PI * 2) / 3;
          st.position.set(Math.cos(ang) * 14, Math.sin(ang) * 5);
        });
      }
    }

    this.drawGloom(now, dtMs);

    // Camera: on you, except during a boss intro, when it glides over to watch the Gloom.
    const me = this.avatars.get(this.you);
    let tx = me ? me.dx * TILE + TILE / 2 : this.camX;
    let ty = me ? me.dy * TILE + TILE / 2 : this.camY;
    if (this.intro > 0 && this.gloom) {
      tx = (this.gloom.sx + 1) * TILE;
      ty = (this.gloom.sy + 1) * TILE;
    }
    const glide = this.intro > 0 || Math.hypot(tx - this.camX, ty - this.camY) > TILE * 2 ? Math.min(1, dtMs / 250) : 1;
    this.camX += (tx - this.camX) * glide;
    this.camY += (ty - this.camY) * glide;
    this.world.position.set(Math.round(this.app.screen.width / 2 - this.camX), Math.round(this.app.screen.height / 2 - this.camY));
    this.onDebug(`tick ${this.serverTick} · pending ${this.pending.length} · ${Math.round(this.app.ticker.FPS)} fps`);
  }

  /**
   * Critters are hidden by the dark too. In light: drawn normally. In the dark: your own critter is
   * just a dark purple outline with its name tag (plus its daze stars); a friend shows the same way
   * only when within a couple of tiles of you, and otherwise can't be seen at all.
   */
  private applyDarkness(a: Avatar): void {
    const me = this.avatars.get(this.you);
    const self = a === me;
    const inLight = (this.light?.level[a.ty * this.w + a.tx] ?? 0) > 0;
    const close = !!me && Math.max(Math.abs(a.tx - me.tx), Math.abs(a.ty - me.ty)) <= SEE_FRIEND_IN_DARK;
    const mode = inLight ? 'full' : self || close ? 'outline' : 'hidden';
    a.root.visible = mode !== 'hidden';
    a.body.visible = mode === 'full';
    a.shadow.visible = mode === 'full';
    a.outline.visible = mode === 'outline';
    a.label.visible = mode !== 'hidden';
    a.label.alpha = mode === 'full' ? 1 : 0.75;
    a.stars.visible = a.ko > 0 && (mode === 'full' || self);
  }

  /** The Gloom slides between tiles and wobbles; while free, a smoky tether carries light away from the Great Heartstone. */
  private drawGloom(now: number, dtMs: number): void {
    const t = this.tether;
    t.clear();
    const g = this.gloom;
    const view = this.gloomView;
    if (!g || !view) return;
    const k = Math.min(1, dtMs / 150);
    g.sx += (g.x - g.sx) * k;
    g.sy += (g.y - g.sy) * k;
    const cx = (g.sx + 1) * TILE;
    const cy = (g.sy + 1) * TILE;
    const wobble = Math.sin(now / (g.restless ? 140 : 260));
    view.position.set(Math.round(cx), Math.round(cy));
    view.scale.set(1 + wobble * 0.04 + (g.pinned ? 0 : 0.04), 1 - wobble * 0.04);
    view.zIndex = g.sy + 1;
    // It's a creature of darkness: you only see it where light falls on it.
    const light = this.light;
    const litAt = (wx: number, wy: number) => {
      if (!light) return false;
      const x = Math.floor(wx / TILE);
      const y = Math.floor(wy / TILE);
      return x >= 0 && y >= 0 && x < this.w && y < this.h && light.level[y * this.w + x]! > 0;
    };
    const shown = gloomFootprint(this.w, g.x, g.y).some((i) => (light?.level[i] ?? 0) > 0);
    const targetAlpha = shown ? (g.pinned ? 0.85 : 1) : 0;
    view.alpha += (targetAlpha - view.alpha) * Math.min(1, dtMs / 120);

    const heart = this.hearts[0];
    if (!heart || g.pinned) return;
    const hx = (heart.idx % this.w) * TILE + TILE / 2;
    const hy = Math.floor(heart.idx / this.w) * TILE + TILE / 2;
    const mx = (hx + cx) / 2;
    const my = (hy + cy) / 2;
    const len = Math.hypot(cx - hx, cy - hy) || 1;
    const bend = Math.sin(now / 700) * Math.min(40, len / 4);
    const qx = mx + (-(cy - hy) / len) * bend;
    const qy = my + ((cx - hx) / len) * bend;
    const at = (p: number): [number, number] => {
      const u = 1 - p;
      return [u * u * hx + 2 * u * p * qx + p * p * cx, u * u * hy + 2 * u * p * qy + p * p * cy];
    };
    // Only the parts of the tether that light falls on are visible.
    const SEGMENTS = 40;
    for (const [width, color, alpha] of [
      [14, 0x2b2040, 0.45],
      [5, 0x5a4880, 0.55],
    ] as const) {
      let drawing = false;
      for (let n = 0; n <= SEGMENTS; n++) {
        const [px, py] = at(n / SEGMENTS);
        const lit = litAt(px, py);
        if (lit && !drawing) {
          t.moveTo(px, py);
          drawing = true;
        } else if (lit) {
          t.lineTo(px, py);
        } else if (drawing) {
          t.stroke({ color, width, alpha, cap: 'round' });
          drawing = false;
        }
      }
      if (drawing) t.stroke({ color, width, alpha, cap: 'round' });
    }
    // Wisps of light flowing from the stone into the Gloom: faster the closer it is (it drains faster).
    const tiles = Math.max(0, len / TILE - 1.5);
    const speed = 350 + 1100 * Math.min(1, tiles / 12);
    for (let n = 0; n < 6; n++) {
      const p = (now / speed + n / 6) % 1;
      const [px, py] = at(p);
      if (!litAt(px, py)) continue;
      t.circle(px, py, 1.5 + 4 * (1 - p)).fill({ color: 0xfff0b0, alpha: 0.85 * (1 - p) + 0.1 });
    }
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
      charged: this.hearts.filter((h) => h.charge >= h.max).length,
      total: this.hearts.length,
      open: this.open,
      gloom: this.gloom !== null,
      pinned: this.gloom?.pinned ?? false,
      intro: this.intro > 0,
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
