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
  GLOWCAP_RADIUS,
  lanternRadius,
  type Loadout,
  Tile,
  actionCost,
  alliesNeverBlock,
  beamCellOf,
  computeLight,
  traceBeamSplit,
  BRIGHT_WICK_RADIUS,
  type Emitter,
  type PartyTalents,
  type TalentId,
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
  type RunSummary,
  type ServerMessage,
} from '@burrowlight/shared';
import { SRC, makeTextures, type Textures } from './textures';
import { sfx } from './sound';

const SCALE = 3;
const TILE = SRC * SCALE; // 48 px on screen
const UNKNOWN = -1;
/** Explored but unlit: barely there, so the room reads as dark. */
const MEMORY_TINT = 0x231e31;
const DIAGONAL_GRACE_MS = 40;
const SHARE_SPREAD_PX = 20;
/** In the dark, another critter shows (as an outline) only within this many tiles of you. */
const SEE_FRIEND_IN_DARK = 2;
/** Hold a direction into soft soil this long to start digging. */
const PUSH_TO_DIG_MS = 350;
/** How long the "Dig here?" question waits for an answer. */
const DIG_PROMPT_MS = 8000;
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
  /** Ticks left digging (0 = not digging). */
  dig: number;
  digBar: Graphics;
  /** Burrow braces left on this floor. */
  braces: number;
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
  /** Worn gear, drawn over the body. */
  gearGfx: Graphics;
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
  braces: number;
}

export interface Objective {
  charged: number;
  total: number;
  open: boolean;
  /** On a boss floor: is the Gloom here, and is it pinned? */
  gloom: boolean;
  /** The Sleeping Giant is here (act 3 boss): how stirred he is (0–100), and whether he's awake. */
  giant: boolean;
  giantStir: number;
  giantAwake: boolean;
  /** The Mothmother is here (act 2 boss), and whether she's sitting on the Great Heartstone. */
  moth: boolean;
  mothOnStone: boolean;
  pinned: boolean;
  /** The boss introduction is playing. */
  intro: boolean;
}

interface Heart {
  idx: number;
  charge: number;
  max: number;
  bar: Graphics;
  /** Heartstones glow faintly even in the dark, so you can always see where they are. */
  glow: Sprite;
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
  /** The whole floor (from the server), for walking and light. `tiles` is only what's been explored and drawn. */
  private realTiles = new Int8Array(0);
  private tileSprites: (Sprite | undefined)[] = [];
  private sunshafts: number[] = [];
  private stairsIdx = -1;
  private traps = new Set<number>();
  private trapSprites = new Map<number, Sprite>();
  /** Snapped-shut traps (harmless), drawn only in light. */
  private sprungSprites = new Map<number, Sprite>();
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
  /** Tunnel holes, keyed "a:b": the two hole sprites. */
  private tunnels = new Map<string, { a: number; b: number; sprites: Sprite[] }>();
  /** When you started pushing into soft soil (to dig after a short hold). */
  private pushSoilSince = 0;
  /** Set once a push has been answered (dig sent or "can't dig"), until you let go. */
  private pushHandled = false;
  /** A dig request waiting for the server's answer. */
  private digSeq = 0;
  /** A dig waiting for the player to confirm (it spends a burrow brace). */
  private digPrompt: { dir: 'n' | 's' | 'e' | 'w'; at: number; since: number; text: Text } | null = null;
  private confirmRequested = false;
  /** Little floating messages above critters ("Can't dig here"). */
  private floaters: { text: Text; born: number; owner: Avatar }[] = [];
  /** Speech bubbles over critters ("Ow!", "AAAH!"): at most one per critter. */
  private bubbles = new Map<Avatar, { root: Container; born: number; life: number }>();
  /** Each critter's tile last frame, for footsteps. */
  private lastTile = new Map<Avatar, number>();
  /** When each panicking critter last screamed. */
  private lastScream = new Map<Avatar, number>();
  private burrowRequested = false;
  private torchSprites = new Map<number, Sprite>();
  /** Pen doors and what opens them, from the server. */
  private locks: { door: number; plate: number; gem: number; charge: number; open: boolean; gemGlow: Sprite | null }[] = [];
  /** Glowcap tile index -> ticks left lit. */
  private glowcaps = new Map<number, number>();
  private glowcapSprites = new Map<number, Sprite>();
  private everLitGlowcap = false;
  /** The Mothmother: server state plus a smoothed drawing position. */
  private moth: { x: number; y: number; landed: boolean; face: number; restless: number; sx: number; sy: number } | null = null;
  private mothView: { root: Container; wings: Graphics[] } | null = null;
  /** The Sleeping Giant: head position, stirring 0–100, awake. */
  private giant: { x: number; y: number; stir: number; awake: boolean } | null = null;
  private giantView: { root: Container; face: Graphics; bubble: Graphics; bar: Graphics; zzz: Text[] } | null = null;
  /** Has this player ever seen a pen door open (for the lock tip)? */
  private doorOpenedOnce = false;
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
  private interactRequested = false;
  private mirrorRequested = false;
  /** Everyone's talents, unspent points and Mirror Pack state, by critter id. */
  private party = new Map<string, { talents: Set<TalentId>; points: number; mirror: boolean; gear: Loadout; vest: 0 | 1 }>();
  /** Fired when anyone's talents or points change. */
  onPartyTalents: (party: Map<string, { talents: Set<TalentId>; points: number; mirror: boolean; gear: Loadout; vest: 0 | 1 }>, you: string) => void = () => {};
  /** Achievement events for you, from the server (your browser counts them toward gear). */
  onFeats: (feats: string[]) => void = () => {};
  /** M: sound on/off. */
  onMuteToggle: () => void = () => {};
  /** One buffered key tap, so quick taps (or a tap while busy) are never lost. */
  private tapped: Dir | null = null;

  onPartyChange: (players: PartyMember[]) => void = () => {};
  onObjective: (o: Objective) => void = () => {};
  onRunEnd: (summary: RunSummary) => void = () => {};
  /** A short how-to-play hint for the first floors, or null. */
  onTip: (tip: string | null) => void = () => {};
  private floor = 1;
  private everLit = false;
  private gateSeen = false;
  /** Has this player used Q on a tunnel yet (for the floor-2 tip)? */
  private usedTunnelKey = false;
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
    this.floor = msg.floor;
    this.gateSeen = false;
    this.tickMs = msg.tickMs;
    this.serverTick = msg.tick;
    this.w = msg.w;
    this.h = msg.h;
    this.tiles = new Int8Array(this.w * this.h).fill(UNKNOWN);
    this.realTiles = Int8Array.from(msg.map);
    for (const layer of [this.tileLayer, this.markerLayer]) layer.removeChildren().forEach((c) => c.destroy());
    this.tileSprites = [];
    this.sunshafts = [];
    this.stairsIdx = -1;
    this.traps.clear();
    this.trapSprites.clear();
    this.sprungSprites.clear();
    this.mirrorSprites.clear();
    this.mirrors.clear();
    this.torchSprites.clear();
    this.torches.clear();
    this.tunnels.clear();
    this.emitters = [];
    for (let k = 0; k < msg.emitters.length; k += 3) {
      const i = msg.emitters[k]!;
      this.emitters.push({ x: i % this.w, y: Math.floor(i / this.w), dx: msg.emitters[k + 1]!, dy: msg.emitters[k + 2]! });
    }
    this.beamGfx = new Graphics();
    this.addTiles(msg.tiles);
    this.locks = [];
    this.setLocks(msg.locks);
    for (const t of msg.traps) this.addTrap(t);
    this.setSprung(msg.sprung);
    this.setMirrors(msg.mirrors);
    this.setTorches(msg.torches);
    this.glowcaps.clear();
    this.glowcapSprites.clear();
    this.setGlowcaps(msg.glowcaps);
    this.setTunnels(msg.tunnels);
    this.intro = msg.intro;
    this.markerLayer.addChild(this.beamGfx);
    this.setParty(msg.party);

    this.hearts = msg.hearts.map((idx, k) => {
      const bar = new Graphics();
      bar.position.set((idx % this.w) * TILE, Math.floor(idx / this.w) * TILE);
      this.markerLayer.addChild(bar);
      const glow = new Sprite(this.tex.heartstone);
      glow.position.set((idx % this.w) * TILE, Math.floor(idx / this.w) * TILE);
      glow.scale.set(SCALE);
      this.markerLayer.addChild(glow);
      const heart = { idx, charge: msg.heartCharge[k] ?? 0, max: msg.heartMax[k] ?? 60, bar, glow };
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
    this.mothView?.root.destroy({ children: true });
    this.mothView = null;
    this.moth = null;
    this.setMoth(msg.moth, true);
    this.giantView?.root.destroy({ children: true });
    this.giantView = null;
    this.giant = null;
    this.setGiant(msg.giant);

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
    if (msg.summary) this.onRunEnd(msg.summary);
  }

  applyTick(msg: Tick): void {
    this.serverTick = msg.tick;
    this.addTiles(msg.tiles);
    this.setLocks(msg.locks);
    if (msg.feats.length) this.onFeats(msg.feats);
    this.setTraps(msg.traps);
    this.setSprung(msg.sprung);
    this.setParty(msg.party);
    msg.heartCharge.forEach((c, k) => {
      const heart = this.hearts[k];
      if (heart && heart.charge < heart.max && c >= heart.max) sfx.heart();
      if (heart && heart.charge !== c) {
        heart.charge = c;
        this.drawHeartBar(heart);
      }
    });
    this.setOpen(msg.open);
    this.setMirrors(msg.mirrors);
    this.setTorches(msg.torches);
    this.setTunnels(msg.tunnels);
    this.intro = msg.intro;
    this.setGloom(msg.gloom, false);
    this.setGlowcaps(msg.glowcaps);
    this.setMoth(msg.moth, false);
    this.setGiant(msg.giant);
    this.applyPositions(msg.pos, msg.ack, false);
    this.lightDirty = true;
    this.emitObjective();
    if (msg.summary) this.onRunEnd(msg.summary);
  }

  private setGlowcaps(flat: number[]): void {
    for (let k = 0; k < flat.length; k += 2) {
      const i = flat[k]!;
      const left = flat[k + 1]!;
      let s = this.glowcapSprites.get(i);
      if (!s) {
        s = new Sprite(this.tex.glowcap[0]);
        s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
        s.scale.set(SCALE);
        s.visible = false;
        this.glowcapSprites.set(i, s);
        this.markerLayer.addChild(s);
      }
      const was = this.glowcaps.get(i) ?? 0;
      this.glowcaps.set(i, left);
      if (left > 0 !== was > 0) {
        s.texture = this.tex.glowcap[left > 0 ? 1 : 0];
        this.lightDirty = true;
        if (left > 0) this.everLitGlowcap = true;
      }
    }
  }

  private setGiant(packed: number[] | null): void {
    if (!packed) {
      this.giantView?.root.destroy({ children: true });
      this.giantView = null;
      this.giant = null;
      return;
    }
    const [x, y, stir, awake] = packed as [number, number, number, number];
    const prev = this.giant;
    this.giant = { x, y, stir, awake: awake === 1 };
    if (prev && !prev.awake && awake === 1) sfx.giantWake();
    if (!this.giantView) this.giantView = this.makeGiantView(x, y);
    if (!prev || prev.awake !== this.giant.awake || Math.floor(prev.stir / 34) !== Math.floor(stir / 34)) this.drawGiantFace();
    const bar = this.giantView.bar;
    bar.clear();
    bar.roundRect(-30, -62, 60, 7, 3).fill(0x1a1524);
    if (stir > 0) bar.roundRect(-30, -62, (60 * stir) / 100, 7, 3).fill(stir > 66 ? 0xf08a7a : stir > 33 ? 0xf2cc8f : 0xa8d8a0);
  }

  /** A huge, mossy old mountain giant asleep against the wall: big nose, droopy ears, bushy brows and beard. */
  private makeGiantView(x: number, y: number): { root: Container; face: Graphics; bubble: Graphics; bar: Graphics; zzz: Text[] } {
    const root = new Container();
    root.position.set((x + 1.5) * TILE, (y + 1) * TILE);
    const face = new Graphics();
    const bubble = new Graphics();
    const bar = new Graphics();
    const zzz = [0, 1, 2].map((k) => {
      const t = new Text({ text: 'z', style: { fontFamily: 'Trebuchet MS', fontSize: 16 + k * 5, fill: 0xd8e8d0, fontWeight: 'bold' } });
      t.anchor.set(0.5);
      root.addChild(t);
      return t;
    });
    root.addChildAt(face, 0);
    root.addChild(bubble, bar);
    root.zIndex = 0.5;
    this.entityLayer.addChild(root);
    return { root, face, bubble, bar, zzz };
  }

  private drawGiantFace(): void {
    const g = this.giant;
    const v = this.giantView;
    if (!g || !v) return;
    const f = v.face;
    const skin = 0x8d9bab;
    const shade = 0x75849a;
    const hair = 0xece4d4;
    const moss = 0x6f8f4e;
    f.clear();
    // Long droopy ears.
    for (const side of [-1, 1]) {
      f.moveTo(side * 52, -6).lineTo(side * 86, 14).lineTo(side * 50, 22).closePath().fill(skin);
      f.moveTo(side * 56, 2).lineTo(side * 76, 13).lineTo(side * 54, 16).closePath().fill(0xb48a96);
    }
    // A broad, craggy head with moss growing on top.
    f.roundRect(-56, -40, 112, 82, 34).fill(skin);
    f.roundRect(-56, 10, 112, 32, 20).fill(shade);
    for (const [mx, my, r] of [[-34, -38, 12], [-12, -44, 14], [14, -42, 12], [36, -36, 10]] as const) f.circle(mx, my, r).fill(moss);
    f.circle(-4, -46, 4).fill(0xe8d06a); // a tiny flower in the moss
    // Bushy brows that scrunch as he stirs; eyes closed (or open, if he's awake).
    const twitch = g.awake ? -6 : g.stir > 66 ? 5 : g.stir > 33 ? 2 : 0;
    for (const side of [-1, 1]) {
      f.ellipse(side * 24, -16 + twitch, 17, 7).fill(hair);
      if (g.awake) {
        f.circle(side * 22, -2, 7).fill(0xffffff);
        f.circle(side * 22, -1, 3.5).fill(0x2a2030);
      } else {
        f.moveTo(side * 22 - 9, -3).quadraticCurveTo(side * 22, 3, side * 22 + 9, -3).stroke({ color: 0x3a3440, width: 3 });
      }
    }
    // A big beard, parted when he shouts.
    for (const [bx, by, r] of [[-38, 30, 16], [-20, 40, 18], [0, 44, 19], [20, 40, 18], [38, 30, 16], [0, 26, 18]] as const)
      f.circle(bx, by, r).fill(hair);
    if (g.awake) f.ellipse(0, 30, 12, 9).fill(0x4a2a30);
    // A huge potato nose over everything.
    f.ellipse(0, 10, 15, 13).fill(shade);
    f.ellipse(-4, 6, 5, 3).fill({ color: 0xffffff, alpha: 0.25 });
  }

  /** Zzz float up while he sleeps; he wobbles harder as he stirs. */
  private drawGiant(now: number): void {
    const g = this.giant;
    const v = this.giantView;
    if (!g || !v) return;
    const shake = g.awake ? Math.sin(now / 30) * 3 : g.stir > 66 ? Math.sin(now / 60) * 1.5 : 0;
    v.face.position.set(shake, 0);
    // A snore bubble from his nose, growing and popping with each snore.
    const snore = (now / 2600) % 1;
    v.bubble.clear();
    if (!g.awake && snore < 0.85) {
      const r = 3 + snore * 14;
      v.bubble.circle(14 + shake + r * 0.6, 16 + r * 0.5, r).fill({ color: 0xcfe8ff, alpha: 0.45 }).stroke({ color: 0xffffff, width: 1.5, alpha: 0.7 });
    }
    v.zzz.forEach((t, k) => {
      const phase = ((now / 1400 + k / 3) % 1 + 1) % 1;
      t.visible = !g.awake;
      t.position.set(30 + phase * 30, -30 - phase * 50);
      t.alpha = 1 - phase;
    });
  }

  private setMoth(packed: number[] | null, snap: boolean): void {
    if (!packed) {
      this.mothView?.root.destroy({ children: true });
      this.mothView = null;
      this.moth = null;
      return;
    }
    const [x, y, landed, face, restless] = packed as [number, number, number, number, number];
    const prev = this.moth;
    this.moth = { x, y, landed: landed === 1, face, restless, sx: snap || !prev ? x : prev.sx, sy: snap || !prev ? y : prev.sy };
    if (!this.mothView) this.mothView = this.makeMothView();
  }

  /** A big, fluffy, soft-glowing moth: cream body, lavender wings, feathery antennae. */
  private makeMothView(): { root: Container; wings: Graphics[] } {
    const root = new Container();
    const glow = new Graphics().circle(0, 0, 46).fill({ color: 0xe8dcff, alpha: 0.12 });
    const wings = [-1, 1].map((side) => {
      const g = new Graphics();
      g.ellipse(side * 22, -8, 24, 18).fill(0xc9b6e8);
      g.ellipse(side * 18, 14, 16, 12).fill(0xb7a2dc);
      g.circle(side * 24, -10, 6).fill(0xf2e8ff); // wing spots
      g.circle(side * 24, -10, 3).fill(0x8a70b8);
      return g;
    });
    const body = new Graphics();
    body.ellipse(0, 4, 10, 20).fill(0xf4ead8);
    body.circle(0, -14, 11).fill(0xfff6e6); // fluffy head
    body.circle(-4, -15, 2.2).fill(0x2a2030); // eyes
    body.circle(4, -15, 2.2).fill(0x2a2030);
    body.circle(-3.4, -15.8, 0.8).fill(0xffffff);
    body.circle(4.6, -15.8, 0.8).fill(0xffffff);
    body.moveTo(-4, -23).quadraticCurveTo(-12, -36, -18, -32).stroke({ color: 0xd8c8a8, width: 2 }); // antennae
    body.moveTo(4, -23).quadraticCurveTo(12, -36, 18, -32).stroke({ color: 0xd8c8a8, width: 2 });
    root.addChild(glow, ...wings, body);
    this.entityLayer.addChild(root);
    return { root, wings };
  }

  /** She flutters between tiles with flapping wings; sitting, her wings fold slowly. */
  private drawMoth(now: number, dtMs: number): void {
    const m = this.moth;
    const v = this.mothView;
    if (!m || !v) return;
    const k = Math.min(1, dtMs / 200);
    m.sx += (m.x - m.sx) * k;
    m.sy += (m.y - m.sy) * k;
    const bob = m.landed ? 0 : Math.sin(now / 180) * 4;
    v.root.position.set(Math.round((m.sx + 1) * TILE), Math.round((m.sy + 1) * TILE + bob));
    v.root.zIndex = m.sy + 3; // she flies above everyone
    const flap = m.landed ? 0.75 + 0.1 * Math.sin(now / 600) : 0.35 + 0.65 * Math.abs(Math.sin(now / (m.restless ? 70 : 110)));
    for (const w of v.wings) w.scale.x = flap;
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

  /** Tunnel openings: a hole at each end, ringed in the color of whoever dug it. */
  private setTunnels(list: [number, number, string][]): void {
    const seen = new Set<string>();
    for (const [a, b, owner] of list) {
      const key = `${a}:${b}`;
      seen.add(key);
      if (this.tunnels.has(key)) continue;
      const color = this.avatars.get(owner)?.info.color ?? 0xffffff;
      const sprites = [a, b].map((i) => {
        const s = new Sprite(this.tex.hole);
        s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
        s.scale.set(SCALE);
        s.tint = color;
        this.markerLayer.addChildAt(s, 0);
        return s;
      });
      this.tunnels.set(key, { a, b, sprites });
      if (this.serverTick > 0) sfx.dig();
    }
    for (const [key, t] of this.tunnels) {
      if (seen.has(key)) continue;
      t.sprites.forEach((s) => s.destroy());
      this.tunnels.delete(key);
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
        if (this.mirrors.has(i) && this.tiles[i] !== UNKNOWN) sfx.mirror();
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
      if (type === Tile.Gate) this.gateSeen = true;
      if (type === Tile.StairsDown) this.stairsIdx = i;
    }
    if (flat.length) this.lightDirty = true;
  }

  /** Pen doors open and shut; plates press down; sun gems fill with sunlight. */
  private setLocks(flat: number[]): void {
    for (let k = 0, n = 0; k < flat.length; k += 5, n++) {
      const [door, plate, gem, charge, open] = flat.slice(k, k + 5) as [number, number, number, number, number];
      let l = this.locks[n];
      if (!l) {
        l = { door, plate, gem, charge: -1, open: false, gemGlow: null };
        if (gem >= 0) {
          l.gemGlow = new Sprite(this.tex.gem[1]);
          l.gemGlow.position.set((gem % this.w) * TILE, Math.floor(gem / this.w) * TILE);
          l.gemGlow.scale.set(SCALE);
          l.gemGlow.alpha = 0;
          this.markerLayer.addChild(l.gemGlow);
        }
        this.locks[n] = l;
      }
      if (l.gemGlow) {
        l.gemGlow.alpha = charge / 100;
        l.gemGlow.visible = this.tiles[gem] !== UNKNOWN;
      }
      l.charge = charge;
      const isOpen = open === 1;
      if (isOpen) this.doorOpenedOnce ||= this.tiles[door] !== UNKNOWN;
      if (isOpen && !l.open && l.charge >= 0 && this.tiles[door] !== UNKNOWN) sfx.door();
      this.realTiles[door] = isOpen ? Tile.DoorOpen : Tile.Door;
      if (this.tiles[door] !== UNKNOWN && this.tiles[door] !== (isOpen ? Tile.DoorOpen : Tile.Door)) {
        this.tiles[door] = isOpen ? Tile.DoorOpen : Tile.Door;
        const s = this.tileSprites[door];
        if (s) s.texture = isOpen ? this.tex.doorOpen : this.tex.door;
        this.lightDirty = true;
      }
      const ps = plate >= 0 ? this.tileSprites[plate] : undefined;
      if (ps) ps.texture = this.tex.plate[isOpen ? 1 : 0];
      l.open = isOpen;
    }
  }

  private textureFor(type: number, x: number, y: number) {
    switch (type) {
      case Tile.Door:
        return this.tex.door;
      case Tile.DoorOpen:
        return this.tex.doorOpen;
      case Tile.Plate:
        return this.tex.plate[0];
      case Tile.Gem:
        return this.tex.gem[0];
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
      case Tile.StoneFloor:
        return this.tex.stoneFloor;
      case Tile.Gate:
        return this.tex.gate;
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
    this.trapSprites.set(i, s);
    this.markerLayer.addChildAt(s, 0);
    this.lightDirty = true;
  }

  /** Traps that snapped shut: drawn closed where light falls on them. */
  private setSprung(list: number[]): void {
    for (const i of list) {
      if (this.sprungSprites.has(i)) continue;
      const s = new Sprite(this.tex.trapShut);
      s.position.set((i % this.w) * TILE, Math.floor(i / this.w) * TILE);
      s.scale.set(SCALE);
      this.sprungSprites.set(i, s);
      this.markerLayer.addChildAt(s, 0);
      this.lightDirty = true;
    }
  }

  /** The full list of traps the party can see: add new ones, drop disarmed ones. */
  private setTraps(list: number[]): void {
    const keep = new Set(list);
    for (const t of list) this.addTrap(t);
    for (const [i, s] of this.trapSprites) {
      if (keep.has(i)) continue;
      s.destroy();
      this.trapSprites.delete(i);
      this.traps.delete(i);
      this.lightDirty = true;
    }
  }

  private setParty(list: PartyTalents): void {
    let changed = false;
    for (const [id, talents, points, mirror, gear, vest] of list) {
      const cur = this.party.get(id);
      const gearKey = (g: Loadout) => `${g.head ?? ''},${g.shirt ?? ''},${g.pants ?? ''}`;
      const key = `${talents.join(',')}|${points}|${mirror}|${gearKey(gear)}|${vest}`;
      const was = cur ? `${[...cur.talents].join(',')}|${cur.points}|${cur.mirror ? 1 : 0}|${gearKey(cur.gear)}|${cur.vest}` : '';
      if (key === was) continue;
      this.party.set(id, { talents: new Set(talents), points, mirror: mirror === 1, gear, vest });
      const a = this.avatars.get(id);
      if (a) drawGear(a.gearGfx, gear, vest);
      changed = true;
    }
    if (changed) {
      this.lightDirty = true;
      this.onPartyTalents(this.party, this.you);
    }
  }

  private has(id: string, talent: TalentId): boolean {
    return this.party.get(id)?.talents.has(talent) ?? false;
  }

  private setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open && this.serverTick > 0) {
      sfx.hatch();
      for (const a of this.avatars.values()) this.bubble(a, 'Yay!');
    }
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
    for (const [id, x, y, conn, lit, oil, ko, jitters, panic, dig, braces] of pos) {
      const a = this.avatars.get(id);
      if (!a) continue;
      seen.add(id);
      a.connected = conn === 1;
      a.root.alpha = a.connected ? 1 : 0.5;
      // Speech bubbles for what just happened.
      if (!snap) {
        const heard = a.info.id === this.you || (a.root.visible && Math.hypot(a.tx - (this.avatars.get(this.you)?.tx ?? 0), a.ty - (this.avatars.get(this.you)?.ty ?? 0)) < 8);
        if (heard && ko > 0 && a.ko === 0) sfx.trap();
        if (heard && panic === 1 && !a.panic) sfx.panic();
        if (heard && jitters - a.jitters >= 15) sfx.snuff();
        if (ko > 0 && a.ko === 0) this.bubble(a, 'Ow!');
        else if (panic === 1 && !a.panic) this.bubble(a, 'AAAH!');
        else if (panic === 0 && a.panic) this.bubble(a, 'Phew.');
        else if (jitters - a.jitters >= 15) this.bubble(a, 'Eep!');
        else if (oil <= 0 && a.oil > 0) this.bubble(a, 'Uh oh...');
        else if (panic === 1 && performance.now() - (this.lastScream.get(a) ?? 0) > 1800) {
          this.bubble(a, ['AAAH!', 'Too dark!', 'Eek!', 'Mama!'][Math.floor(Math.random() * 4)]!);
          this.lastScream.set(a, performance.now());
        }
      }
      a.lit = lit === 1;
      a.oil = oil;
      a.ko = ko;
      a.stars.visible = ko > 0;
      a.jitters = jitters;
      a.dig = dig;
      a.braces = braces;
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
    // The server turned a dig down (e.g. stone hiding behind soil we couldn't see yet).
    const me = this.avatars.get(this.you);
    if (this.digSeq && ack >= this.digSeq && me) {
      if (me.dig === 0) this.say(me, "Can't dig here");
      this.digSeq = 0;
    }
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
      if (!e.repeat) this.interactRequested = true;
      return;
    }
    if (e.code === 'KeyR') {
      if (!e.repeat) this.mirrorRequested = true;
      return;
    }
    if (e.code === 'KeyM') {
      if (!e.repeat) this.onMuteToggle();
      return;
    }
    if (e.code === 'KeyQ') {
      if (!e.repeat) this.burrowRequested = true;
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!e.repeat) this.confirmRequested = true;
      return;
    }
    if (e.code === 'Escape') {
      this.clearDigPrompt();
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
    this.pushHandled = false;
    this.pushSoilSince = 0;
  };

  /** The server's answer to "can I dig here?": ask to confirm, or say why not. */
  digCheck(msg: Extract<ServerMessage, { t: 'digCheck' }>): void {
    const me = this.avatars.get(this.you);
    if (!me) return;
    if (!msg.ok) {
      this.say(me, msg.reason);
      return;
    }
    // Spending a brace is a big decision: ask first.
    this.clearDigPrompt();
    const text = new Text({
      text: `Dig under here? Uses ${me.braces === 1 ? 'your burrow brace' : '1 burrow brace'}. Press Enter`,
      style: { fontFamily: 'Trebuchet MS, sans-serif', fontSize: 13, fill: 0xf2cc8f, stroke: { color: 0x0b0a10, width: 3 } },
    });
    text.anchor.set(0.5, 1);
    text.zIndex = 9999;
    this.entityLayer.addChild(text);
    this.digPrompt = { dir: msg.dir, at: me.ty * this.w + me.tx, since: performance.now(), text };
  }

  private clearDigPrompt(): void {
    this.digPrompt?.text.destroy();
    this.digPrompt = null;
  }

  /** A short message that floats up from a critter and fades. */
  /** A little white speech bubble above a critter. */
  private bubble(a: Avatar, message: string, life = 1500): void {
    this.bubbles.get(a)?.root.destroy({ children: true });
    const root = new Container();
    const text = new Text({ text: message, style: { fontFamily: 'Trebuchet MS, sans-serif', fontSize: 13, fill: 0x2a2030, fontWeight: 'bold' } });
    text.anchor.set(0.5);
    const w = text.width + 14;
    const h = text.height + 6;
    const g = new Graphics();
    g.roundRect(-w / 2, -h / 2, w, h, 8).fill(0xfff8ec).stroke({ color: 0x2a2030, width: 1.5 });
    g.moveTo(-4, h / 2 - 1).lineTo(0, h / 2 + 6).lineTo(4, h / 2 - 1).closePath().fill(0xfff8ec);
    root.addChild(g, text);
    root.zIndex = 9998;
    this.entityLayer.addChild(root);
    this.bubbles.set(a, { root, born: performance.now(), life });
    if (message.startsWith('AAAH') || message === 'Eek!' || message === 'Too dark!' || message === 'Mama!') this.lastScream.set(a, performance.now());
  }

  private say(a: Avatar, message: string): void {
    const text = new Text({
      text: message,
      style: { fontFamily: 'Trebuchet MS, sans-serif', fontSize: 13, fill: 0xfff4e0, stroke: { color: 0x0b0a10, width: 3 } },
    });
    text.anchor.set(0.5, 1);
    this.entityLayer.addChild(text);
    this.floaters.push({ text, born: performance.now(), owner: a });
  }

  private toggleLantern(): void {
    const me = this.avatars.get(this.you);
    if (!me) return;
    if (me.panic || me.ko > 0 || this.intro > 0) return;
    const on = !this.myLit;
    if (on && me.oil <= 0) {
      this.say(me, 'Out of oil');
      return;
    }
    this.myLit = on;
    if (on) sfx.lanternOn();
    else sfx.lanternOff();
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
    // A pending dig: Enter confirms; walking away (or waiting 5 s) cancels.
    if (this.digPrompt) {
      const here = me.ty * this.w + me.tx;
      if (here !== this.digPrompt.at || now - this.digPrompt.since > DIG_PROMPT_MS) this.clearDigPrompt();
    }
    if (this.confirmRequested) {
      this.confirmRequested = false;
      if (this.digPrompt) {
        action = { kind: 'dig', dir: this.digPrompt.dir };
        this.clearDigPrompt();
        const seq = ++this.seq;
        this.digSeq = seq;
        this.pending.push({ seq, action });
        this.send({ t: 'intent', seq, action });
        this.readyAt = now + actionCost(action) * this.tickMs;
        return;
      }
    }
    if (this.interactRequested) {
      this.interactRequested = false;
      action = { kind: 'interact' };
    } else if (this.mirrorRequested) {
      this.mirrorRequested = false;
      action = { kind: 'mirror' };
    } else if (this.burrowRequested) {
      this.burrowRequested = false;
      action = { kind: 'burrow' };
      const here = me.ty * this.w + me.tx;
      if ([...this.tunnels.values()].some((t) => t.a === here || t.b === here)) this.usedTunnelKey = true;
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
      if (!actual) {
        // Pushing into soft soil for a moment starts digging a tunnel under it.
        const [ddx, ddy] = DIRS[dir];
        const ahead = this.knownTile(me.tx + ddx, me.ty + ddy);
        const pushing = !isDiagonal(dir) && held === dir && (ahead === Tile.Wall || ahead === Tile.Gate || ahead === Tile.Door);
        if (!pushing) {
          this.pushSoilSince = 0;
          return;
        }
        if (this.pushHandled) return; // already answered this push; let go to try again
        if (!this.pushSoilSince) this.pushSoilSince = now;
        if (now - this.pushSoilSince < PUSH_TO_DIG_MS) return;
        this.pushSoilSince = 0;
        this.pushHandled = true;
        // Ask the server, which can see behind the wall: the prompt only appears for a dig that will work.
        this.send({ t: 'checkDig', dir: dir as 'n' | 's' | 'e' | 'w' });
        return;
      }
      this.pushSoilSince = 0;
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

  /** The real floor: walls are known from the start (they're just not drawn until explored). */
  private knownTile = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return Tile.Wall;
    return this.realTiles[y * this.w + x] ?? Tile.Wall;
  };

  /** For movement: the real floor, so prediction always matches the server. */
  private moveTile = this.knownTile;


  // ---------- Light ----------

  /** The same light rules as the server, run locally so your own lantern moves with you instantly. */
  private refreshLight(): void {
    const sources: LightSource[] = [];
    for (const [id, a] of this.avatars) {
      const lit = id === this.you ? this.myLit && a.oil > 0 : a.lit;
      const pm = this.party.get(id);
      if (lit) sources.push({ x: a.tx, y: a.ty, radius: lanternRadius(pm?.talents ?? new Set(), pm?.gear ?? {}), strength: 1 });
    }
    for (const i of this.sunshafts) sources.push({ x: i % this.w, y: Math.floor(i / this.w), radius: SUNSHAFT_RADIUS, strength: 1 });
    for (const [i, on] of this.torches) if (on) sources.push({ x: i % this.w, y: Math.floor(i / this.w), radius: TORCH_RADIUS, strength: 1 });
    for (const [i, left] of this.glowcaps) if (left > 0) sources.push({ x: i % this.w, y: Math.floor(i / this.w), radius: GLOWCAP_RADIUS, strength: 1 });

    // Sunbeams, traced locally like the server does. Critters standing in a beam block it.
    const occupied = new Set<number>();
    const prisms = new Set<number>();
    const vests = new Map<number, 0 | 1>();
    for (const [id, a] of this.avatars) {
      const i = a.ty * this.w + a.tx;
      const pm = this.party.get(id);
      if (this.has(id, 'prism')) prisms.add(i);
      else if (pm && Object.values(pm.gear).includes('mirrorVest') && !this.mirrors.has(i)) vests.set(i, pm.vest);
      else occupied.add(i);
    }
    if (this.gloom) for (const i of gloomFootprint(this.w, this.gloom.x, this.gloom.y)) occupied.add(i);
    const beams = this.emitters
      .filter((e) => this.tiles[e.y * this.w + e.x] !== UNKNOWN)
      .flatMap((e) =>
        traceBeamSplit(
          this.w,
          this.h,
          (x, y) => beamCellOf(this.knownTile(x, y)),
          e,
          (i) => this.mirrors.get(i) ?? vests.get(i),
          (i) => occupied.has(i) && !vests.has(i),
          (i) => prisms.has(i),
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
    for (const [i, s] of this.glowcapSprites) {
      const lit = (this.glowcaps.get(i) ?? 0) > 0;
      s.visible = this.tiles[i] !== UNKNOWN || lit;
      s.tint = lit ? 0xffffff : light.glow[i]! > 0 ? lightTint(light.glow[i]!) : MEMORY_TINT;
    }
    for (const h of this.hearts) {
      const lit = light.glow[h.idx]! > 0;
      h.glow.tint = lit ? lightTint(light.glow[h.idx]!) : 0x8fa6dd;
      h.glow.alpha = lit ? 1 : 0.8;
    }
    if (this.myLit) this.everLit = true;
    this.updateTip();
    this.light = light;
    for (let i = 0; i < this.tileSprites.length; i++) {
      const s = this.tileSprites[i];
      if (s) s.tint = light.glow[i]! > 0 ? lightTint(light.glow[i]!) : MEMORY_TINT;
    }
    // Known traps stay drawn in the dark (dimly), so nobody walks back onto one they've found.
    for (const [i, s] of this.trapSprites) s.tint = light.glow[i]! > 0 ? lightTint(light.glow[i]!) : MEMORY_TINT;
    // Sprung traps are harmless: only drawn where light falls, so they don't clutter the dark.
    for (const [i, s] of this.sprungSprites) {
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
    const digBar = new Graphics();
    digBar.position.set(0, -TILE * 0.5 - 22);
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
    const gearGfx = new Graphics();
    root.addChild(shadow, body, gearGfx, outline, lamp, stars, digBar, label);
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
      dig: 0,
      digBar,
      braces: 0,
      jitters: 0,
      panic: false,
      gearGfx,
      root,
      body,
      outline,
      shadow,
      label,
      stars,
      lamp,
    });
    const pm = this.party.get(info.id);
    if (pm) drawGear(gearGfx, pm.gear, pm.vest);
  }

  private frame(dtMs: number): void {
    const now = performance.now();
    this.handleInput(now);
    if (this.lightDirty) this.refreshLight();
    // Footsteps: yours, and softer ones for critters close by that you can see.
    const meA = this.avatars.get(this.you);
    for (const a of this.avatars.values()) {
      const tile = a.ty * this.w + a.tx;
      const was = this.lastTile.get(a);
      this.lastTile.set(a, tile);
      if (was === undefined || was === tile || a.dig > 0) continue;
      const far = Math.abs(a.tx - (was % this.w)) + Math.abs(a.ty - Math.floor(was / this.w)) > 2; // tunnels, new floors
      if (far) continue;
      if (a === meA) sfx.step();
      else if (meA && a.root.visible && Math.max(Math.abs(a.tx - meA.tx), Math.abs(a.ty - meA.ty)) <= 5) sfx.step(0.4);
    }

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
      // Digging: a little progress bar above the critter, and a busy wiggle.
      a.digBar.clear();
      if (a.dig > 0 && a.root.visible) {
        const f = 1 - a.dig / 30;
        a.digBar.roundRect(-16, 0, 32, 5, 2).fill({ color: 0x0b0a10, alpha: 0.8 });
        a.digBar.roundRect(-15, 1, 30 * f, 3, 1.5).fill(0xc9a07a);
        a.body.rotation = Math.sin(now / 60) * 0.12;
      }
      if (a.ko > 0) {
        // Stars circle the dazed critter's head.
        a.stars.children.forEach((st, k) => {
          const ang = now / 300 + (k * Math.PI * 2) / 3;
          st.position.set(Math.cos(ang) * 14, Math.sin(ang) * 5);
        });
      }
    }

    this.drawGloom(now, dtMs);
    this.drawMoth(now, dtMs);
    this.drawGiant(now);

    if (this.digPrompt) {
      const mine = this.avatars.get(this.you);
      if (mine) this.digPrompt.text.position.set(mine.root.x, mine.root.y - TILE * 0.85);
    }

    // Speech bubbles pop up, wobble a little, and pop away; hidden when their critter can't be seen.
    for (const [a, b] of this.bubbles) {
      const age = (now - b.born) / b.life;
      if (age >= 1 || a.root.destroyed) {
        b.root.destroy({ children: true });
        this.bubbles.delete(a);
        continue;
      }
      const pop = Math.min(1, age * 8);
      b.root.scale.set(pop * (1 + 0.04 * Math.sin(now / 90)));
      b.root.position.set(a.root.x, a.root.y - TILE * 1.05 - (a.ko > 0 ? 10 : 0));
      b.root.visible = a.root.visible;
      b.root.alpha = age > 0.8 ? (1 - age) * 5 : 1;
    }

    // Floating messages rise and fade over 1.4 s.
    this.floaters = this.floaters.filter((f) => {
      const age = (now - f.born) / 1400;
      if (age >= 1 || f.owner.root.destroyed) {
        f.text.destroy();
        return false;
      }
      f.text.position.set(f.owner.root.x, f.owner.root.y - TILE * 0.85 - age * 18);
      f.text.alpha = 1 - age * age;
      f.text.zIndex = 9999;
      return true;
    });

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
    a.gearGfx.visible = mode === 'full';
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
        braces: a.braces,
      })),
    );
  }

  /** Hints for the first floors: how light works on floor 1, how burrowing works on floor 2. */
  /** Tips this player has already had (remembered by the browser), and whether tips are on at all. */
  tipsSeen = new Set<string>();
  tipsOn = true;
  /** A tip went away because its job was done: don't show it again. */
  onTipSeen: (id: string) => void = () => {};
  private lastTipId: string | null = null;

  private updateTip(): void {
    const unfinished = this.hearts.some((h) => h.charge < h.max);
    const me = this.avatars.get(this.you);
    const seenTile = (i: number) => this.tiles[i] !== UNKNOWN;
    const pens = this.locks.filter((l) => !l.open && seenTile(l.door));
    // In order of importance; the first that applies (and hasn't been seen before) shows.
    const tips: [id: string, active: boolean, text: string][] = [
      ['hatch', this.floor === 1 && this.open, 'The hatch is open! Everyone stand on the ladder to go down.'],
      ['lantern', !this.everLit, "It's dark down here. Press Space to light your lantern. It burns oil, so use it wisely."],
      ['heartstone', this.floor === 1 && unfinished, 'Find the Heartstone (look for its glow) and stand near it with your lantern lit. More light charges it faster.'],
      ['jitters', !!me && me.jitters > 50 && !me.panic, "You're getting the Jitters in the dark! Stand in any light, or right next to a friend."],
      ['trap', !!me && me.ko > 0, 'Snap! A hidden trap. Traps show up once light falls on them.'],
      ['dig', unfinished && this.gateSeen && this.tunnels.size === 0, 'That Heartstone is fenced in. Walk into the gate and hold to dig under it.'],
      ['tunnel', this.tunnels.size > 0 && !this.usedTunnelKey, 'You came out the other side! To go back through, stand on a tunnel hole and press Q.'],
      ['mirror', unfinished && [...this.mirrorSprites.keys()].some(seenTile) && this.emitters.some((e) => seenTile(e.y * this.w + e.x)), 'A sunbeam! Stand on a mirror and press E to turn it. Sunlight charges Heartstones too.'],
      ['torch', [...this.torches.keys()].some(seenTile) && ![...this.torches.values()].some(Boolean) && !this.gloom, 'A torch. Walk over it with your lantern lit and it gives free light.'],
      ['gloom', !!this.gloom && unfinished && this.intro === 0, "The Gloom eats light and steals the Great Heartstone's. Lure it with a lantern into a sunbeam's path, then turn a mirror onto it!"],
      ['giant', !!this.giant && unfinished && (this.giant.stir === 0 && this.hearts.every((h) => h.charge < h.max / 3)), "Shh! Light on the Giant's face stirs him. Light the Great Heartstone from the shadows: behind counters, or with a sunbeam."],
      ['moth', !!this.moth && !this.everLitGlowcap, 'The Mothmother loves light! Light glowcaps away from the Great Heartstone to lure her off it.'],
      ['glowcap', this.floor >= 4 && !this.everLitGlowcap && [...this.glowcapSprites.keys()].some(seenTile), 'Glowcaps! Walk over one with your lantern lit and it glows for a while, free.'],
      ['plate', unfinished && !this.doorOpenedOnce && pens.some((l) => l.plate >= 0 && seenTile(l.plate)), 'A locked pen! Someone stand on the pressure plate to hold its door open (or dig under the wall).'],
      ['gem', unfinished && !this.doorOpenedOnce && pens.some((l) => l.gem >= 0 && seenTile(l.gem)), 'A locked pen! Turn the mirrors to shine a sunbeam into the sun gem, and the door opens for good.'],
    ];
    const pick = this.tipsOn ? tips.find(([id, active]) => active && !this.tipsSeen.has(id)) : undefined;
    const id = pick?.[0] ?? null;
    if (id === this.lastTipId) return;
    // The tip that was showing has done its job (or the floor changed): never show it again.
    if (this.lastTipId && !tips.find(([t]) => t === this.lastTipId)?.[1]) {
      this.tipsSeen.add(this.lastTipId);
      this.onTipSeen(this.lastTipId);
    }
    this.lastTipId = id;
    this.onTip(pick?.[2] ?? null);
  }

  private mothOnStone(): boolean {
    const m = this.moth;
    const h = this.hearts[0];
    return Boolean(m && h && m.landed && gloomFootprint(this.w, m.x, m.y).includes(h.idx));
  }

  private emitObjective(): void {
    this.onObjective({
      charged: this.hearts.filter((h) => h.charge >= h.max).length,
      total: this.hearts.length,
      open: this.open,
      gloom: this.gloom !== null,
      moth: this.moth !== null,
      giant: this.giant !== null,
      giantStir: this.giant?.stir ?? 0,
      giantAwake: this.giant?.awake ?? false,
      mothOnStone: this.mothOnStone(),
      pinned: this.gloom?.pinned ?? false,
      intro: this.intro > 0,
    });
  }
}

/** Worn gear, drawn over a critter (centred on its body; 48 px tile). */
function drawGear(g: Graphics, gear: Loadout, vest: 0 | 1): void {
  g.clear();
  if (gear.head === 'candleCrown') {
    g.rect(-9, -24, 18, 5).fill(0xd8b45a);
    for (const x of [-7, 0, 7]) {
      g.rect(x - 1.5, -31, 3, 7).fill(0xfff4e0);
      g.circle(x, -33, 2).fill(0xffb347);
    }
  } else if (gear.head === 'owlGoggles') {
    g.rect(-11, -10, 22, 2).fill(0x5a3a2a);
    for (const x of [-6, 6]) g.circle(x, -9, 5).fill(0x8a6a48).circle(x, -9, 3).fill(0xa8e0ff);
  }
  if (gear.shirt === 'mirrorVest') {
    g.roundRect(-10, 2, 20, 9, 3).fill(0xc8d4e0);
    const d = vest === 0 ? 1 : -1;
    g.moveTo(-6, 6 + 3 * d).lineTo(6, 6 - 3 * d).stroke({ color: 0xffffff, width: 2 });
  } else if (gear.shirt === 'cozySweater') {
    g.roundRect(-10, 2, 20, 9, 3).fill(0xc0504d);
    g.rect(-10, 5, 20, 2).fill(0xf4ead8);
  }
  if (gear.pants === 'diggingDungarees') {
    g.rect(-9, 11, 18, 6).fill(0x4a6a9a);
    g.rect(-6, 4, 2, 8).fill(0x4a6a9a);
    g.rect(4, 4, 2, 8).fill(0x4a6a9a);
  } else if (gear.pants === 'lanternBelt') {
    g.rect(-10, 11, 20, 3).fill(0x6e4520);
    g.rect(-3, 10, 6, 5).fill(0xd8b45a);
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
