import { MAX_OIL, normalizeCode, type LobbyPlayer, type ServerMessage } from '@burrowlight/shared';
import { GameView } from './game';
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
  if (await ensureConnected()) net.send({ t: 'create', name: playerName() });
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
    ...players.map(({ info, connected, you, lit, oil, ko, jitters, panic }) => {
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
      text.append(name, bar, jit);
      li.append(dot, text);
      return li;
    }),
  );
};

game.onRunOver = () => {
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

let floorText = '';
game.onObjective = ({ charged, total, open }) => {
  const goal = open
    ? 'The hatch is open! Everyone gather on the ladder.'
    : `Light the Heartstone${total > 1 ? 's' : ''} (${charged}/${total}): more light charges it faster`;
  $('banner').replaceChildren(document.createTextNode(floorText), document.createElement('br'), Object.assign(document.createElement('small'), { textContent: goal }));
};
const debugEl = $('debug');
game.onDebug = (t) => (debugEl.textContent = t);

// ---------- Messages ----------

net.onMessage = async (msg) => {
  switch (msg.t) {
    case 'error':
      setError(msg.message);
      break;
    case 'lobby':
      session = { code: msg.code, token: msg.token };
      saveSession(session);
      history.replaceState(null, '', `?room=${msg.code}`);
      status(null);
      setError('');
      renderLobby(msg);
      show('lobby');
      break;
    case 'welcome':
      session = { code: msg.code, token: msg.token };
      saveSession(session);
      history.replaceState(null, '', `?room=${msg.code}`);
      status(null);
      show('game');
      await game.mount($('canvas-host'));
      floorText = `Rootcellar · Floor ${msg.floor} · Burrow ${msg.code}`;
      game.loadWelcome(msg);
      break;
    case 'tick':
      game.applyTick(msg);
      break;
  }
};

// ---------- Reconnect ----------

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
