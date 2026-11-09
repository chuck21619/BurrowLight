/**
 * Tiny synthesized sound effects (no audio files): soft, cozy blips made with Web Audio.
 * The browser only allows sound after the player has pressed a key or clicked, which every
 * game action is, so the audio context starts on the first sound.
 */
let ctx: AudioContext | null = null;
let isMuted = false;

export function setSoundMuted(m: boolean): void {
  isMuted = m;
}

function audio(): AudioContext | null {
  if (isMuted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One note: a frequency glide with a quick attack and a soft fade. */
function tone(freq: number, dur: number, opts: { type?: OscillatorType; to?: number; gain?: number; delay?: number } = {}): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + (opts.delay ?? 0);
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
  const peak = opts.gain ?? 0.12;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** A puff of filtered noise (whooshes and snaps). */
function noise(dur: number, freq: number, gainPeak = 0.15, delay = 0): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const gain = ac.createGain();
  gain.gain.value = gainPeak;
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t0);
}

export const sfx = {
  lanternOn: () => tone(520, 0.12, { to: 780, gain: 0.08 }),
  lanternOff: () => tone(520, 0.12, { to: 300, gain: 0.06 }),
  mirror: () => tone(1200, 0.05, { type: 'triangle', gain: 0.06 }),
  trap: () => {
    noise(0.08, 2500, 0.3);
    tone(180, 0.15, { type: 'square', to: 90, gain: 0.06 });
  },
  dig: () => noise(0.25, 300, 0.25),
  heart: () => [660, 880, 1320].forEach((f, k) => tone(f, 0.35, { delay: k * 0.08, gain: 0.08 })),
  hatch: () => [523, 659, 784, 1047].forEach((f, k) => tone(f, 0.4, { type: 'triangle', delay: k * 0.1, gain: 0.08 })),
  snuff: () => noise(0.35, 700, 0.18),
  panic: () => tone(900, 0.18, { type: 'triangle', to: 1400, gain: 0.05 }),
  giantWake: () => {
    tone(70, 0.8, { type: 'sawtooth', to: 50, gain: 0.08 });
    noise(0.8, 400, 0.2, 0.15);
  },
  unlock: () => [988, 1319, 1568, 1976].forEach((f, k) => tone(f, 0.25, { delay: k * 0.07, gain: 0.06 })),
  door: () => tone(220, 0.2, { type: 'triangle', to: 330, gain: 0.07 }),
};
