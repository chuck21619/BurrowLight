import {
  MAX_OIL,
  TALENTS,
  TREES,
  actName,
  actOf,
  isBossFloor,
  learnProblem,
  normalizeCode,
  formatRunTime,
  type LeaderboardEntry,
  talentDef,
  type LobbyPlayer,
  type RunSummary,
  type ServerMessage,
  type TalentId,
} from '@burrowlight/shared';
import { GEAR, gearDef, type GearId, type GearSlot, type Loadout } from '@burrowlight/shared';
import { gearIcon } from './gearIcons';
import { GameView } from './game';
import { setSoundMuted, sfx } from './sound';
import { isTouchDevice, mountTouchControls, type TouchControls } from './touch';
import { markTipSeen, muted, progress, recordFeats, setMuted, setTipsOn, setWearing, tipsOn, tipsSeen, unlocked, wearing } from './save';
import { Net } from './net';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = { home: $('home'), lobby: $('lobby'), game: $('game') };
type Screen = keyof typeof screens;

const NAMES = ['Pip', 'Moss', 'Clover', 'Fern', 'Hazel', 'Juniper', 'Bramble', 'Thistle', 'Acorn', 'Maple', 'Sorrel', 'Wren'];
const RECONNECT_FOR_MS = 60_000;

// Rejoin details live in sessionStorage, so two tabs in one browser are two different players.
interface Session {
  code: string;
  token: string;
}
const loadSession = (): Session | null => {
  try {
    return JSON.parse(sessionStorage.getItem('burrowlight.session') ?? 'null');
  } catch {
    return null;
  }
};
const saveSession = (s: Session) => {
  try {
    sessionStorage.setItem('burrowlight.session', JSON.stringify(s));
  } catch {
    /* storage unavailable: rejoin just won't survive a reload */
  }
};

const net = new Net();
const game = new GameView((m) => net.send(m));
let screen: Screen = 'home';
let session = loadSession();
let myId = '';
let amReady = false;
let reconnectUntil = 0;

function show(s: Screen) {
  screen = s;
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== s;
}

function status(text: string | null) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function setError(text: string) {
  $(screen === 'lobby' ? 'lobby-error' : 'home-error').textContent = text;
}

// ---------- Home ----------

const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
try {
  nameInput.value = localStorage.getItem('burrowlight.name') ?? '';
} catch {
  /* ignore */
}
if (!nameInput.value) nameInput.value = NAMES[Math.floor(Math.random() * NAMES.length)]!;
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) codeInput.value = normalizeCode(urlCode);

function playerName() {
  const n = nameInput.value.trim() || 'Critter';
  try {
    localStorage.setItem('burrowlight.name', n);
  } catch {
    /* ignore */
  }
  return n;
}

async function ensureConnected(): Promise<boolean> {
  if (net.open) return true;
  try {
    await net.connect();
    return true;
  } catch (e) {
    setError((e as Error).message);
    return false;
  }
}

$('create').addEventListener('click', async () => {
  setError('');
  // Dev only: ?floor=3 starts the run on floor 3 (a boss floor) for testing.
  const devFloor = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('floor')) || 1 : 1;
  // Dev only: ?seed=N replays the same run.
  const devSeed = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('seed')) || undefined : undefined;
  if (await ensureConnected()) net.send({ t: 'create', name: playerName(), startFloor: devFloor, seed: devSeed });
});

async function join(code: string) {
  setError('');
  if (code.length !== 5) return setError('Codes are 5 letters.');
  if (!(await ensureConnected())) return;
  const token = session?.code === code ? session.token : undefined;
  net.send({ t: 'join', code, name: playerName(), token });
}

$('join').addEventListener('click', () => join(normalizeCode(codeInput.value)));
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join(normalizeCode(codeInput.value));
});

// ---------- Lobby ----------

$('ready').addEventListener('click', () => {
  amReady = !amReady;
  net.send({ t: 'ready', ready: amReady });
});
$('start').addEventListener('click', () => net.send({ t: 'start' }));
$('copy-link').addEventListener('click', async () => {
  const btn = $('copy-link');
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied!';
  } catch {
    btn.textContent = location.href;
  }
  setTimeout(() => (btn.textContent = 'Copy invite link'), 2000);
});

function renderLobby(msg: Extract<ServerMessage, { t: 'lobby' }>) {
  myId = msg.you;
  $('lobby-code').textContent = msg.code;
  const list = $('lobby-players');
  list.replaceChildren(...msg.players.map((p) => lobbyRow(p, p.id === msg.hostId, p.id === msg.you)));
  const me = msg.players.find((p) => p.id === myId);
  amReady = me?.ready ?? false;
  $('ready').textContent = amReady ? 'Not ready' : "I'm ready";
  const isHost = msg.hostId === myId;
  const allReady = msg.players.every((p) => p.ready);
  const start = $<HTMLButtonElement>('start');
  start.hidden = !isHost;
  start.disabled = !allReady;
  $('lobby-hint').textContent = isHost
    ? allReady
      ? 'Everyone is ready. Start when you like!'
      : 'Waiting for everyone to be ready…'
    : 'The host starts the run when everyone is ready.';
}

// ---------- Gear ----------

const SLOT_NAMES: Record<GearSlot, string> = { head: 'Head', shirt: 'Shirt', pants: 'Pants' };
let gearSentFor = '';

function sendGear() {
  net.send({ t: 'gear', gear: wearing() });
}

function gearDescription(id: string | undefined, slot: GearSlot): string {
  const g = id ? gearDef(id) : undefined;
  if (!g) return `${SLOT_NAMES[slot]}: nothing.`;
  if (!unlocked(g.id)) return `${g.name} (locked): ${g.unlock}${g.needs > 1 ? ` ${progress(g)}/${g.needs}` : ''}`;
  return `${g.name}: ${g.text}`;
}

function renderGear() {
  const current = wearing();
  const slots = $('gear-slots');
  slots.replaceChildren();
  const tip = $('gear-tip');
  const showTip = (btn: HTMLElement, textValue: string) => {
    tip.textContent = textValue;
    tip.hidden = false;
    const panel = btn.closest('.panel')!.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, panel.left + 8), panel.right - w - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
  };
  const hideTip = () => (tip.hidden = true);
  for (const slot of ['head', 'shirt', 'pants'] as GearSlot[]) {
    const label = document.createElement('span');
    label.className = 'gear-slot-name';
    label.textContent = SLOT_NAMES[slot];
    const row = document.createElement('div');
    row.className = 'gear-row';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', `${SLOT_NAMES[slot]} gear`);
    const options: (string | undefined)[] = [undefined, ...GEAR.filter((d) => d.slot === slot).map((d) => d.id)];
    for (const id of options) {
      const def = id ? gearDef(id) : undefined;
      const locked = def ? !unlocked(def.id) : false;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gear-item' + ((current[slot] ?? undefined) === id ? ' selected' : '') + (locked ? ' locked' : '');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String((current[slot] ?? undefined) === id));
      btn.setAttribute('aria-label', def ? `${def.name}${locked ? ' (locked)' : ''}` : 'Nothing');
      const img = document.createElement('img');
      img.src = gearIcon((id as GearId | undefined) ?? 'none');
      img.alt = '';
      btn.append(img);
      if (locked) {
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.textContent = '🔒';
        btn.append(lock);
      }
      btn.addEventListener('mouseenter', () => showTip(btn, gearDescription(id, slot)));
      btn.addEventListener('focus', () => showTip(btn, gearDescription(id, slot)));
      btn.addEventListener('mouseleave', hideTip);
      btn.addEventListener('blur', hideTip);
      btn.addEventListener('click', () => {
        if (locked) {
          showTip(btn, gearDescription(id, slot)); // a tap on a phone shows how to unlock it
          return;
        }
        const next: Loadout = { ...wearing() };
        if (id) next[slot] = id as GearId;
        else delete next[slot];
        setWearing(next);
        sendGear();
        renderGear();
      });
      row.append(btn);
    }
    slots.append(label, row);
  }
  hideTip();
  const locked = GEAR.filter((g) => !unlocked(g.id));
  $('gear-locked').hidden = locked.length === 0;
  $('gear-unlocks').replaceChildren(
    ...locked.map((g) => {
      const li = document.createElement('li');
      li.textContent = `${g.name} (${SLOT_NAMES[g.slot].toLowerCase()}): ${g.unlock}${g.needs > 1 ? ` ${progress(g)}/${g.needs}` : ''}`;
      return li;
    }),
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

game.tipsSeen = new Set(tipsSeen());
game.tipsOn = tipsOn();
game.onTipSeen = (id) => markTipSeen(id);
const tipsBox = $<HTMLInputElement>('tips-on');
tipsBox.checked = tipsOn();
tipsBox.addEventListener('change', () => {
  setTipsOn(tipsBox.checked);
  game.tipsOn = tipsBox.checked;
  game.tipsSeen = new Set(tipsSeen());
});
setSoundMuted(muted());
game.onMuteToggle = () => {
  const m = !muted();
  setMuted(m);
  setSoundMuted(m);
  toast(m ? 'Sound off (M to turn it back on)' : 'Sound on');
};

game.onFeats = (feats) => {
  const fresh = recordFeats(feats);
  if (fresh.length) sfx.unlock();
  if (fresh.length) toast(`New gear unlocked: ${fresh.map((g) => g.name).join(', ')}! Wear it from the lobby next run.`);
};

function lobbyRow(p: LobbyPlayer, host: boolean, you: boolean) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
  const name = document.createElement('span');
  name.textContent = `${p.name}${you ? ' (you)' : ''}${host ? ' · host' : ''}`;
  const tag = document.createElement('span');
  tag.className = p.ready ? 'tag ok' : 'tag';
  tag.textContent = p.ready ? 'ready' : 'not ready';
  li.append(dot, name, tag);
  return li;
}

// ---------- Game HUD ----------

game.onPartyChange = (players) => {
  $('party').replaceChildren(
    ...players.map(({ info, connected, you, lit, oil, ko, jitters, panic, braces }) => {
      const li = document.createElement('li');
      if (!connected) li.className = 'away';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = `#${info.color.toString(16).padStart(6, '0')}`;
      const text = document.createElement('div');
      text.className = 'member';
      const name = document.createElement('span');
      const state = panic
        ? ' · has the jitters!'
        : ko > 0
          ? ' · seeing stars'
          : !connected
            ? ' · dozing'
            : lit
              ? ' · lantern lit'
              : '';
      name.textContent = `${info.name}${you ? ' (you)' : ''}${state}`;
      const brace = document.createElement('span');
      brace.className = 'braces';
      brace.title = 'Burrow braces: each one digs a tunnel on this floor';
      brace.textContent = `braces ${braces}`;
      const bar = document.createElement('div');
      bar.className = 'oil';
      const fill = document.createElement('div');
      fill.className = lit ? 'oil-fill burning' : 'oil-fill';
      fill.style.width = `${Math.round((oil / MAX_OIL) * 100)}%`;
      bar.title = `Oil: ${Math.ceil(oil / 10)} seconds of light`;
      bar.append(fill);
      const jit = document.createElement('div');
      jit.className = 'jitters';
      jit.title = 'The Jitters: fills in the dark, calms in light';
      const jitFill = document.createElement('div');
      jitFill.className = panic ? 'jitters-fill panic' : 'jitters-fill';
      jitFill.style.width = `${jitters}%`;
      jit.append(jitFill);
      const top = document.createElement('div');
      top.className = 'member-top';
      top.append(name, brace);
      text.append(top, bar, jit);
      const known = partyTalents.get(info.id);
      if (known && known.size) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        for (const t of known) {
          const c = document.createElement('span');
          c.className = 'chip';
          c.textContent = talentDef(t)!.name;
          chips.append(c);
        }
        text.append(chips);
      }
      li.append(dot, text);
      return li;
    }),
  );
};

game.onTip = (tip) => {
  const el = $('tip');
  el.hidden = !tip;
  el.textContent = tip ?? '';
};

let runEnded = false;
function renderBoard(entries: LeaderboardEntry[], rank: number | null, ranked: boolean) {
  const box = $('runover-board');
  box.hidden = false;
  const list = $('runover-board-list');
  list.replaceChildren(
    ...entries.map((e, k) => {
      const li = document.createElement('li');
      if (rank === k + 1) li.className = 'you';
      const place = document.createElement('span');
      place.textContent = `${k + 1}.`;
      const who = document.createElement('span');
      who.textContent = e.names.join(', ');
      const time = document.createElement('span');
      time.textContent = formatRunTime(e.seconds);
      li.append(place, who, time);
      return li;
    }),
  );
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = 'No winning runs yet. Be the first!';
    list.append(li);
  }
  $('runover-board-note').textContent =
    rank !== null ? `Your run placed #${rank}!` : ranked ? 'Not fast enough for the top 10 this time.' : '';
}

game.onRunEnd = (s: RunSummary) => {
  if (runEnded) return;
  runEnded = true;
  $('runover-title').textContent = s.won ? 'The Hearthlight is restored!' : 'Eek!';
  $('runover-sub').textContent = s.won
    ? 'You beat all three acts and carried the light home. Well done, critters.'
    : `Everyone got the jitters at once, on floor ${s.floorReached} (${actName(s.floorReached)}).`;
  const time = `${Math.floor(s.seconds / 60)}:${String(s.seconds % 60).padStart(2, '0')}`;
  const rows: [string, string | number][] = [
    ['Floors cleared', s.floorsCleared],
    ['Heartstones lit', s.heartstones],
    ['Time', time],
    ['Lantern light burned', `${s.oilSeconds} s`],
    ['Traps sprung', s.trapsSprung],
    ['Panics', s.panics],
    ['Tunnels dug', s.tunnels],
    ['Gloom pinned', s.pins],
  ];
  $('runover-stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = String(v);
      li.append(a, b);
      return li;
    }),
  );
  $('runover').hidden = false;
};
$('again').addEventListener('click', () => {
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  location.href = location.pathname;
});

// ---------- Talents ----------

let myTalents = new Set<TalentId>();
let myPoints = 0;
let partyTalents = new Map<string, Set<TalentId>>();

function renderTalentMenu() {
  $('talent-points').textContent =
    myPoints > 0 ? `${myPoints} talent point${myPoints > 1 ? 's' : ''} to spend` : 'No points: you earn one each floor you go down';
  $('talent-trees').replaceChildren(
    ...TREES.map((tree) => {
      const col = document.createElement('div');
      col.className = 'tree';
      const h = document.createElement('h3');
      h.textContent = tree.name;
      col.append(h);
      const inTree = TALENTS.filter((t) => t.tree === tree.id);
      const root = inTree.find((t) => !t.requires)!;
      const branches = inTree.filter((t) => t.requires);
      const button = (id: TalentId) => {
        const def = talentDef(id)!;
        const b = document.createElement('button');
        const learned = myTalents.has(id);
        const problem = learnProblem(myTalents, myPoints, id);
        b.className = `talent ${learned ? 'learned' : problem ? 'locked' : 'available'}`;
        b.disabled = learned || !!problem;
        b.title = learned ? 'Learned' : (problem ?? 'Learn this talent');
        const name = document.createElement('strong');
        name.textContent = def.name;
        const text = document.createElement('span');
        text.textContent = def.text;
        b.append(name, text);
        b.addEventListener('click', () => net.send({ t: 'learn', talent: id }));
        return b;
      };
      const row = document.createElement('div');
      row.className = 'branches';
      row.append(...branches.map((t) => button(t.id)));
      col.append(button(root.id), row);
      return col;
    }),
  );
}

function toggleTalents(open = $('talents').hidden) {
  $('talents').hidden = !open;
  if (open) renderTalentMenu();
}
window.addEventListener('keydown', (e) => {
  if (screen !== 'game' || e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyT' && !e.repeat) toggleTalents();
  if (e.code === 'Escape') toggleTalents(false);
});
$('talents-close').addEventListener('click', () => toggleTalents(false));

game.onPartyTalents = (party, you) => {
  const mine = party.get(you);
  touchControls?.setMirrorAvailable(mine?.talents.has('mirrorPack') ?? false);
  myTalents = new Set(mine?.talents ?? []);
  myPoints = mine?.points ?? 0;
  partyTalents = new Map([...party].map(([id, p]) => [id, p.talents]));
  $('point-hint').hidden = myPoints <= 0;
  $('point-hint').textContent = `${myPoints} talent point${myPoints > 1 ? 's' : ''}: ${game.touch ? 'tap Talents' : 'press T'}`;
  if (!$('talents').hidden) renderTalentMenu();
};

let floorText = '';
let touchControls: TouchControls | null = null;
game.onObjective = ({ charged, total, open, gloom, pinned, intro, moth, mothOnStone, giant, giantStir, giantAwake }) => {
  const goal = intro
    ? 'Something in the dark is hungry for light...'
    : open
    ? 'The hatch is open! Everyone gather on the ladder.'
    : giant
      ? giantAwake
        ? 'WHO TURNED ON THE LIGHTS?! (He blew them all out.)'
        : giantStir > 50
          ? 'Shh! The Giant is stirring. Get the light off his face!'
          : 'Charge the Great Heartstone without waking the Giant: keep light off his face'
    : moth
      ? mothOnStone
        ? 'The Mothmother is sipping the Great Heartstone! Light glowcaps to lure her away'
        : 'Charge the Great Heartstone, and keep the Mothmother busy with other lights'
    : gloom
      ? pinned
        ? 'The Gloom is pinned! Pour light into the Great Heartstone'
        : "The Gloom is stealing the Great Heartstone's light. Pin it in a sunbeam!"
      : `Light the Heartstone${total > 1 ? 's' : ''} (${charged}/${total}): more light charges it faster`;
  $('banner').replaceChildren(document.createTextNode(floorText), document.createElement('br'), Object.assign(document.createElement('small'), { textContent: goal }));
};
game.onClock = (s) => {
  const el = $('timer');
  const t = formatRunTime(s);
  if (el.textContent !== t) el.textContent = t;
};
const debugEl = $('debug');
// The tick / fps readout is for development only.
if (import.meta.env.DEV) game.onDebug = (t) => (debugEl.textContent = t);

// ---------- Messages ----------

net.onMessage = async (msg) => {
  switch (msg.t) {
    case 'error':
      if (rejoining && session) {
        // The game we were trying to get back into is gone (the server restarted, went to sleep, or
        // redeployed): stop retrying and say so, instead of "Reconnecting…" forever.
        rejoining = false;
        session = null;
        try {
          sessionStorage.removeItem('burrowlight.session');
        } catch {
          /* ignore */
        }
        history.replaceState(null, '', location.pathname);
        status(null);
        $('runover').hidden = true;
        show('home');
        setError('That game has ended: the server restarted. Make a new burrow to play again.');
        break;
      }
      setError(msg.message);
      break;
    case 'lobby':
      rejoining = false;
      session = { code: msg.code, token: msg.token };
      saveSession(session);
      history.replaceState(null, '', `?room=${msg.code}`);
      status(null);
      setError('');
      renderLobby(msg);
      renderGear();
      if (gearSentFor !== msg.code + msg.you) {
        gearSentFor = msg.code + msg.you;
        sendGear();
      }
      show('lobby');
      break;
    case 'welcome':
      rejoining = false;
      session = { code: msg.code, token: msg.token };
      saveSession(session);
      history.replaceState(null, '', `?room=${msg.code}`);
      status(null);
      show('game');
      await game.mount($('canvas-host'));
      if (isTouchDevice() && !touchControls) {
        touchControls = mountTouchControls($('hud'));
        game.touch = true;
        game.onDigPrompt = (on) => touchControls?.setDigOffered(on);
      }
      floorText = `Act ${actOf(msg.floor)}: ${actName(msg.floor)} · Floor ${msg.floor}${isBossFloor(msg.floor) ? ' (boss)' : ''} · Burrow ${msg.code}`;
      game.loadWelcome(msg);
      break;
    case 'tick':
      game.applyTick(msg);
      break;
    case 'leaderboard':
      renderBoard(msg.entries, msg.rank, msg.ranked);
      break;
    case 'digCheck':
      game.digCheck(msg);
      break;
  }
};

// ---------- Reconnect ----------

/** Waiting to hear whether the server still has our game. */
let rejoining = false;

net.onClose = () => {
  if (screen === 'home' || !session) return;
  reconnectUntil = Date.now() + RECONNECT_FOR_MS;
  tryReconnect();
};

async function tryReconnect() {
  if (!session) return;
  if (Date.now() > reconnectUntil) {
    status(null);
    show('home');
    setError('Lost connection to the burrow.');
    return;
  }
  status('Reconnecting…');
  try {
    await net.connect();
    rejoining = true;
    net.send({ t: 'join', code: session.code, name: playerName(), token: session.token });
  } catch {
    setTimeout(tryReconnect, 1000);
  }
}

// Coming back to a tab you were playing in (reload): rejoin automatically.
if (session && urlCode && normalizeCode(urlCode) === session.code) {
  join(session.code);
}

// Dev-only handle for debugging and automated playtests from the browser console.
if (import.meta.env.DEV) (window as unknown as { __game: GameView }).__game = game;
