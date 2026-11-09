/**
 * On-screen controls for phones and tablets. They don't talk to the game directly: they press the
 * same keys a keyboard would (as synthetic key events), so every rule and prediction stays shared.
 *
 * Left thumb: a d-pad (8 directions; hold toward a wall to dig, like holding a key).
 * Right thumb: Light, Use, Tunnel, Mirror, and Dig when a dig is offered. Top: Talents and Sound.
 */
export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);

const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code }));
const tap = (code: string) => {
  key('keydown', code);
  key('keyup', code);
};

export interface TouchControls {
  /** Show the Dig button while the game is offering a dig. */
  setDigOffered(on: boolean): void;
  /** Show the Mirror button once the critter has the Mirror Pack talent. */
  setMirrorAvailable(on: boolean): void;
}

export function mountTouchControls(host: HTMLElement): TouchControls {
  document.body.classList.add('touch');
  const root = document.createElement('div');
  root.className = 'touch-controls';

  // ---- D-pad ----
  const pad = document.createElement('div');
  pad.className = 'dpad';
  pad.setAttribute('aria-label', 'Move');
  const knob = document.createElement('div');
  knob.className = 'dpad-knob';
  pad.append(knob);
  let held = new Set<string>();
  const setHeld = (next: Set<string>) => {
    for (const c of held) if (!next.has(c)) key('keyup', c);
    for (const c of next) if (!held.has(c)) key('keydown', c);
    held = next;
  };
  const steer = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const max = r.width / 2;
    const k = Math.min(1, len / max);
    knob.style.transform = `translate(${(dx / (len || 1)) * k * max * 0.55}px, ${(dy / (len || 1)) * k * max * 0.55}px)`;
    const next = new Set<string>();
    if (len > max * 0.2) {
      // 8 directions: a diagonal when the thumb is clearly between two arrows.
      const nx = dx / len;
      const ny = dy / len;
      if (nx > 0.38) next.add('KeyD');
      if (nx < -0.38) next.add('KeyA');
      if (ny > 0.38) next.add('KeyS');
      if (ny < -0.38) next.add('KeyW');
    }
    setHeld(next);
  };
  const release = () => {
    knob.style.transform = '';
    setHeld(new Set());
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    steer(e);
  });
  pad.addEventListener('pointermove', (e) => {
    if (pad.hasPointerCapture(e.pointerId)) steer(e);
  });
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  // ---- Buttons ----
  const button = (label: string, code: string, cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `touch-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tap(code);
    });
    return b;
  };
  const actions = document.createElement('div');
  actions.className = 'touch-actions';
  const light = button('Light', 'Space', 'big');
  const use = button('Use', 'KeyE', '');
  const tunnel = button('Tunnel', 'KeyQ', '');
  const mirror = button('Mirror', 'KeyR', '');
  mirror.hidden = true;
  const dig = button('Dig!', 'Enter', 'dig');
  dig.hidden = true;
  actions.append(dig, mirror, tunnel, use, light);

  const top = document.createElement('div');
  top.className = 'touch-top';
  top.append(button('Talents', 'KeyT', 'small'), button('Sound', 'KeyM', 'small'));

  root.append(pad, actions, top);
  host.append(root);
  window.addEventListener('blur', release);

  return {
    setDigOffered: (on) => (dig.hidden = !on),
    setMirrorAvailable: (on) => (mirror.hidden = !on),
  };
}
