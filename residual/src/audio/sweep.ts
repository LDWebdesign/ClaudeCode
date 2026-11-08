/**
 * The receiver sweep. Steps through the band every ~100 ms; each step is a short burst of
 * inter-station hiss with a hard mute between steps, the way hardware spirit boxes chop
 * audio. Some steps land near a "station" and carry broadcast bleed instead: slivers of
 * speech (from the voice bank, far too short to be words), music, heterodyne whistles or hum.
 * When a station is present the hiss drops (FM capture effect).
 */
import type { ResidualConfig } from '../config';
import { type Rng, between, chance, pick, pickWeighted } from '../util/rng';
import type { AudioEngine } from './engine';
import { radioChain } from './engine';
import type { VoiceBank } from './voicebank';

export type StationKind = 'speech' | 'music' | 'whistle' | 'hum';

export interface StepInfo {
  time: number;
  duration: number;
  /** MHz for FM, kHz for AM */
  freq: number;
  /** 0..1 apparent signal strength */
  level: number;
  station: StationKind | null;
}

const BANDS = {
  FM: { min: 87.5, max: 108.0, step: 0.2, decimals: 1 },
  AM: { min: 530, max: 1700, step: 10, decimals: 0 },
} as const;

export class Sweep {
  private running = false;
  private timer?: number;
  private nextTime = 0;
  private freq: number = BANDS.FM.min;
  private steps: StepInfo[] = [];
  private noiseSrc?: AudioBufferSourceNode;
  private stepGain: GainNode;
  private duckGain: GainNode;
  private lowpass: BiquadFilterNode;
  private highpass: BiquadFilterNode;
  private bleedIn: AudioNode;

  constructor(
    private readonly engine: AudioEngine,
    private readonly config: () => ResidualConfig,
    private readonly rng: Rng,
    private bank?: VoiceBank,
  ) {
    const ctx = engine.ctx;
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 250;
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 5000;
    this.stepGain = ctx.createGain();
    this.stepGain.gain.value = 0;
    this.duckGain = ctx.createGain();
    this.highpass.connect(this.lowpass).connect(this.stepGain).connect(this.duckGain).connect(engine.buses.static);

    const chain = radioChain(ctx, { highpass: 380, lowpass: 2700, presence: 1500, distortion: 0.45 });
    chain.output.connect(engine.buses.bleed);
    this.bleedIn = chain.input;
  }

  setBank(bank: VoiceBank): void {
    this.bank = bank;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get band() {
    return BANDS[this.config().spiritBox.sweep.band];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const ctx = this.engine.ctx;
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = this.engine.noise;
    this.noiseSrc.loop = true;
    this.noiseSrc.connect(this.highpass);
    this.noiseSrc.start();
    this.nextTime = ctx.currentTime + 0.05;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.clearInterval(this.timer);
    const t = this.engine.ctx.currentTime;
    this.stepGain.gain.cancelScheduledValues(t);
    this.stepGain.gain.setTargetAtTime(0, t, 0.01);
    this.noiseSrc?.stop(t + 0.1);
    this.noiseSrc = undefined;
  }

  /** The step audible at a given context time (accounts for output latency). */
  current(time = this.engine.ctx.currentTime - (this.engine.ctx.outputLatency || 0)): StepInfo | undefined {
    for (let i = this.steps.length - 1; i >= 0; i--) if (this.steps[i].time <= time) return this.steps[i];
    return this.steps[0];
  }

  /** Start time of the first step boundary at or after `time`. */
  nextBoundary(time: number): number {
    for (const s of this.steps) if (s.time >= time) return s.time;
    return this.nextTime;
  }

  /** Lowers the hiss while something else holds the channel (capture effect). */
  duck(from: number, to: number, depth: number): void {
    const g = this.duckGain.gain;
    g.cancelScheduledValues(from);
    g.setTargetAtTime(Math.max(0.03, 1 - depth), from, 0.012);
    g.setTargetAtTime(1, to, 0.05);
  }

  formatFreq(freq: number): string {
    return freq.toFixed(this.band.decimals);
  }

  private schedule(): void {
    const ctx = this.engine.ctx;
    const cfg = this.config().spiritBox;
    const horizon = ctx.currentTime + 0.25;
    while (this.nextTime < horizon) {
      const base = cfg.sweep.stepMs / 1000;
      const d = Math.max(0.035, base * (1 + (this.rng.next() * 2 - 1) * cfg.sweep.stepJitter));
      this.scheduleStep(this.nextTime, d);
      this.nextTime += d;
    }
    const cutoff = ctx.currentTime - 2;
    while (this.steps.length > 4 && this.steps[0].time < cutoff) this.steps.shift();
  }

  private scheduleStep(t: number, d: number): void {
    const cfg = this.config().spiritBox;
    const band = this.band;
    const dir = cfg.sweep.direction === 'up' ? 1 : -1;
    this.freq += band.step * dir;
    if (this.freq > band.max) this.freq = band.min;
    if (this.freq < band.min) this.freq = band.max;
    if (cfg.sweep.band === 'AM' && (this.freq < BANDS.AM.min || this.freq > BANDS.AM.max)) this.freq = BANDS.AM.min;
    if (cfg.sweep.band === 'FM' && this.freq > 200) this.freq = BANDS.FM.min;

    const bleed = cfg.audio.radioBleed;
    const stationChance = 0.05 + 0.32 * bleed;
    const station: StationKind | null = chance(this.rng, stationChance)
      ? pickWeighted<StationKind>(this.rng, cfg.sweep.band === 'FM' ? { speech: 5, music: 3, whistle: 1, hum: 0.6 } : { speech: 4, music: 1.5, whistle: 2.5, hum: 2 }) ?? null
      : null;

    let level = between(this.rng, 0.45, 1);
    if (chance(this.rng, 0.07)) level = between(this.rng, 0.05, 0.18); // near-dead step
    const hiss = (station ? 0.3 : 1) * level * cfg.audio.staticLevel;

    const g = this.stepGain.gain;
    const gap = Math.min(0.012, d * 0.12);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(hiss, t + gap);
    g.setValueAtTime(hiss, t + d - 0.006);
    g.linearRampToValueAtTime(0, t + d - 0.001);

    const am = cfg.sweep.band === 'AM';
    this.lowpass.frequency.setValueAtTime(am ? between(this.rng, 1500, 3400) : between(this.rng, 2600, 7800), t);
    this.highpass.frequency.setValueAtTime(between(this.rng, 120, am ? 300 : 650), t);

    if (station) this.scheduleStation(station, t + gap, d - gap - 0.004, bleed);

    this.steps.push({
      time: t,
      duration: d,
      freq: this.freq,
      level: Math.min(1, (station ? 0.55 + level * 0.45 : level * 0.45) + this.rng.next() * 0.08),
      station,
    });
  }

  private scheduleStation(kind: StationKind, t: number, d: number, bleed: number): void {
    const ctx = this.engine.ctx;
    const out = ctx.createGain();
    const lvl = (0.25 + 0.35 * bleed) * this.config().spiritBox.audio.voiceLevel;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(lvl, t + 0.006);
    out.gain.setValueAtTime(lvl, t + d - 0.006);
    out.gain.linearRampToValueAtTime(0, t + d);
    out.connect(this.bleedIn);
    const end = t + d + 0.02;
    const cleanup = (node: AudioScheduledSourceNode) => (node.onended = () => out.disconnect());

    switch (kind) {
      case 'speech': {
        if (!this.bank) return;
        const take = pick(this.rng, this.bank.takes);
        const len = Math.min(d, take.duration, between(this.rng, 0.05, 0.15));
        const src = ctx.createBufferSource();
        const reversed = chance(this.rng, 0.35);
        src.buffer = reversed ? this.bank.reversed : this.bank.buffer;
        src.playbackRate.value = between(this.rng, 0.85, 1.25);
        const takeStart = reversed ? this.bank.buffer.duration - take.start - take.duration : take.start;
        const offset = takeStart + this.rng.next() * Math.max(0, take.duration - len);
        src.connect(out);
        src.start(t, offset, len);
        cleanup(src);
        break;
      }
      case 'music': {
        const root = between(this.rng, 110, 330);
        const ratios = pick(this.rng, [[1, 1.25, 1.5], [1, 1.2, 1.5], [1, 1.5, 2], [1, 1.335]]);
        const mix = ctx.createGain();
        mix.gain.value = 0.22;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = between(this.rng, 900, 2200);
        mix.connect(lp).connect(out);
        let last: OscillatorNode | undefined;
        for (const r of ratios) {
          const o = ctx.createOscillator();
          o.type = chance(this.rng, 0.5) ? 'sawtooth' : 'triangle';
          o.frequency.value = root * r * between(this.rng, 0.995, 1.005);
          o.connect(mix);
          o.start(t);
          o.stop(end);
          last = o;
        }
        if (last) cleanup(last);
        break;
      }
      case 'whistle': {
        const o = ctx.createOscillator();
        o.type = 'sine';
        const f0 = between(this.rng, 500, 3000);
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(80, f0 * between(this.rng, 0.4, 1.8)), t + d);
        const g = ctx.createGain();
        g.gain.value = 0.18;
        o.connect(g).connect(out);
        o.start(t);
        o.stop(end);
        cleanup(o);
        break;
      }
      case 'hum': {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = chance(this.rng, 0.5) ? 60 : 50;
        const g = ctx.createGain();
        g.gain.value = 0.12;
        o.connect(g).connect(out);
        o.start(t);
        o.stop(end);
        cleanup(o);
        break;
      }
    }
  }
}
