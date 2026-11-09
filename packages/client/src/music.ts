import { createRng } from '@burrowlight/shared';
import { audioContext } from './sound';

/**
 * Background music, composed in code: a soft pad, a gentle bass and a little melody on a loop.
 * Each act has its own tune (key, mode, tempo, instrument) and each boss a tenser one. Melodies are
 * generated from a fixed seed, so a theme is always the same tune.
 */
interface Theme {
  bpm: number;
  /** MIDI note of the key's root. */
  root: number;
  /** Semitone steps of the mode. */
  scale: number[];
  /** Scale degree of each bar's chord (the loop is twice through, with a varied melody). */
  chords: number[];
  lead: OscillatorType;
  seed: number;
  /** How often a melody slot gets a note. */
  busy: number;
  /** Bass on every eighth note (bosses) rather than beats 1 and 3. */
  drive: boolean;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

export type ThemeId = 'cellar' | 'grotto' | 'kitchen' | 'gloom' | 'moth' | 'giant';

const THEMES: Record<ThemeId, Theme> = {
  cellar: { bpm: 80, root: 60, scale: MAJOR, chords: [0, 5, 3, 4], lead: 'triangle', seed: 11, busy: 0.55, drive: false },
  grotto: { bpm: 70, root: 62, scale: DORIAN, chords: [0, 3, 0, 6], lead: 'sine', seed: 23, busy: 0.45, drive: false },
  kitchen: { bpm: 96, root: 65, scale: MAJOR, chords: [0, 3, 4, 0], lead: 'square', seed: 37, busy: 0.6, drive: false },
  gloom: { bpm: 100, root: 57, scale: MINOR, chords: [0, 5, 6, 4], lead: 'triangle', seed: 41, busy: 0.45, drive: true },
  moth: { bpm: 92, root: 62, scale: LYDIAN, chords: [0, 1, 0, 4], lead: 'sine', seed: 53, busy: 0.55, drive: true },
  giant: { bpm: 84, root: 53, scale: MINOR, chords: [0, 3, 5, 4], lead: 'triangle', seed: 67, busy: 0.35, drive: true },
};

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
/** The MIDI note of a scale degree (degrees past 7 go up an octave). */
const noteOf = (t: Theme, degree: number) => {
  const oct = Math.floor(degree / 7);
  const d = ((degree % 7) + 7) % 7;
  return t.root + oct * 12 + t.scale[d]!;
};

/** A theme's melody: one degree (or null for a rest) per eighth note, for the whole 8-bar loop. */
function composeMelody(t: Theme): (number | null)[] {
  const rng = createRng(t.seed);
  const bars = [...t.chords, ...t.chords];
  const out: (number | null)[] = [];
  let at = 7; // start near the octave above the root
  bars.forEach((chord, bar) => {
    for (let slot = 0; slot < 8; slot++) {
      const strong = slot % 4 === 0;
      if (!strong && rng.next() > t.busy) {
        out.push(null);
        continue;
      }
      if (strong) {
        // Land on a chord tone on strong beats.
        const tones = [chord, chord + 2, chord + 4, chord + 7].map((d) => d + 7);
        at = tones.reduce((best, d) => (Math.abs(d - at) < Math.abs(best - at) ? d : best), tones[0]!);
      } else {
        at += rng.pick([-2, -1, -1, 1, 1, 2]);
        at = Math.max(4, Math.min(13, at));
      }
      // The second time through, end each phrase differently.
      if (bar >= 4 && slot === 7 && rng.next() < 0.5) out.push(null);
      else out.push(at);
    }
  });
  return out;
}

class Music {
  private enabled = true;
  private theme: Theme | null = null;
  private melody: (number | null)[] = [];
  private bus: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Audio-clock time of the next eighth note to schedule, and its index in the loop. */
  private nextAt = 0;
  private step = 0;
  private current: ThemeId | null = null;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stop();
    else if (this.current) this.play(this.current, true);
  }

  play(id: ThemeId, force = false): void {
    if (!force && id === this.current && this.timer) return;
    this.current = id;
    if (!this.enabled) return;
    const ac = audioContext();
    if (!ac) return;
    this.fadeOut();
    this.theme = THEMES[id];
    this.melody = composeMelody(this.theme);
    this.bus = ac.createGain();
    this.bus.gain.setValueAtTime(0.0001, ac.currentTime);
    this.bus.gain.exponentialRampToValueAtTime(0.5, ac.currentTime + 2); // fade in
    this.bus.connect(ac.destination);
    this.nextAt = ac.currentTime + 0.1;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 100);
  }

  /** Fade out and stop (end of a run). */
  stop(): void {
    this.fadeOut();
  }

  private fadeOut(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ac = audioContext();
    const bus = this.bus;
    this.bus = null;
    if (!ac || !bus) return;
    bus.gain.cancelScheduledValues(ac.currentTime);
    bus.gain.setValueAtTime(bus.gain.value, ac.currentTime);
    bus.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 1.2);
    setTimeout(() => bus.disconnect(), 1500);
  }

  /** Schedule every note that starts in the next 0.4 s (a steady clock, even if timers stutter). */
  private schedule(): void {
    const ac = audioContext();
    const t = this.theme;
    if (!ac || !t || !this.bus) return;
    const eighth = 60 / t.bpm / 2;
    if (this.nextAt < ac.currentTime - 1) this.nextAt = ac.currentTime + 0.05; // tab was asleep: don't burst
    while (this.nextAt < ac.currentTime + 0.4) {
      const total = t.chords.length * 2 * 8;
      const i = this.step % total;
      const bar = Math.floor(i / 8);
      const slot = i % 8;
      const chord = t.chords[bar % t.chords.length]!;
      const at = this.nextAt;
      if (slot === 0) this.pad(t, chord, at, eighth * 8);
      if (t.drive || slot % 4 === 0) this.bass(t, chord, at, t.drive ? eighth * 0.9 : eighth * 3.5);
      const m = this.melody[i];
      if (m !== null && m !== undefined) this.lead(t, m, at, eighth * (this.melody[i + 1] === null ? 1.8 : 0.95));
      this.nextAt += eighth;
      this.step++;
    }
  }

  private voice(type: OscillatorType, hz: number, at: number, dur: number, peak: number, attack: number, cutoff?: number): void {
    const ac = audioContext()!;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, at);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node: AudioNode = osc;
    if (cutoff) {
      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      osc.connect(filter);
      node = filter;
    }
    node.connect(gain).connect(this.bus!);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** A soft, slow chord that fills the bar. */
  private pad(t: Theme, chord: number, at: number, dur: number): void {
    for (const d of [chord, chord + 2, chord + 4]) {
      const hz = freq(noteOf(t, d));
      this.voice('sine', hz, at, dur, 0.035, dur * 0.3);
      this.voice('triangle', hz * 1.003, at, dur, 0.015, dur * 0.4, 900); // a slight detune for warmth
    }
  }

  private bass(t: Theme, chord: number, at: number, dur: number): void {
    this.voice('triangle', freq(noteOf(t, chord) - 24), at, dur, 0.09, 0.02, 500);
  }

  private lead(t: Theme, degree: number, at: number, dur: number): void {
    const peak = t.lead === 'square' ? 0.025 : 0.06; // square is buzzier: keep it quiet
    this.voice(t.lead, freq(noteOf(t, degree)), at, dur, peak, 0.012, t.lead === 'square' ? 1800 : undefined);
  }
}

export const music = new Music();

/** Which tune plays on a floor. */
export function themeForFloor(floor: number): ThemeId {
  const act = Math.ceil(floor / 3);
  const boss = floor % 3 === 0;
  if (act === 1) return boss ? 'gloom' : 'cellar';
  if (act === 2) return boss ? 'moth' : 'grotto';
  return boss ? 'giant' : 'kitchen';
}
