/**
 * Renders fragment plans into audio. Vocal fragments are slices of the voice bank pushed
 * through a per-fragment receiver chain whose bandwidth, saturation, dropouts and flutter
 * follow the plan's clarity; they always land on a sweep step boundary, and the hiss is
 * ducked under them as if a signal briefly captured the receiver.
 */
import type { ResidualConfig } from '../config';
import type { EventPlan, VoicePlan } from '../spiritbox/correlation';
import { type Rng, between, chance, clamp, intBetween, lerp, pick } from '../util/rng';
import type { AudioEngine } from './engine';
import { radioChain } from './engine';
import type { Sweep } from './sweep';
import { type Take, type VoiceBank, reversedStart } from './voicebank';

interface Segment {
  buffer: AudioBuffer;
  offset: number;
  duration: number;
}

export interface Rendered {
  start: number;
  /** seconds of audible output */
  duration: number;
}

export class FragmentRenderer {
  constructor(
    private readonly engine: AudioEngine,
    private readonly sweep: Sweep,
    private readonly bank: VoiceBank,
    private readonly config: () => ResidualConfig,
    private readonly rng: Rng,
  ) {}

  voice(plan: VoicePlan, earliest = this.engine.now + 0.03): Rendered {
    const ctx = this.engine.ctx;
    const cfg = this.config().spiritBox.audio;
    const rng = this.rng;
    const clarity = plan.clarity;
    const takes = this.bank.byEntry.get(plan.entry.id) ?? [pick(rng, this.bank.takes)];
    const take = pick(rng, takes);
    const segments = this.segments(plan, take);
    const rate = plan.form === 'unintelligible' ? between(rng, 0.72, 0.95) : between(rng, 0.9, 1.07);

    const start = this.sweep.isRunning ? this.sweep.nextBoundary(earliest) : earliest;
    const playLen = segments.reduce((s, x) => s + x.duration, 0) / rate;

    const chain = radioChain(ctx, {
      highpass: lerp(560, 240, clarity) * between(rng, 0.85, 1.15),
      lowpass: lerp(1700, 3400, clarity) * between(rng, 0.9, 1.08),
      presence: between(rng, 1250, 1900),
      distortion: clamp(cfg.distortion * lerp(1.25, 0.75, clarity), 0, 1),
    });

    // Gate: multipath flutter + dropouts on sweep boundaries.
    const gate = ctx.createGain();
    const drop = ctx.createGain();
    const level = ctx.createGain();
    chain.output.connect(gate).connect(drop).connect(level).connect(this.engine.buses.voice);

    const flutterDepth = (1 - clarity) * 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = between(rng, 3.5, 11);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = flutterDepth / 2;
    gate.gain.value = 1 - flutterDepth / 2;
    lfo.connect(lfoGain).connect(gate.gain);
    lfo.start(start);
    lfo.stop(start + playLen + 0.1);

    const stepLen = this.config().spiritBox.sweep.stepMs / 1000;
    const dropChance = (1 - clarity) * 0.55;
    drop.gain.setValueAtTime(1, start);
    for (let t = start + stepLen * between(rng, 0.6, 1.2); t < start + playLen - 0.03; t += stepLen * between(rng, 0.8, 1.2)) {
      if (!chance(rng, dropChance)) continue;
      const len = between(rng, 0.015, 0.055);
      const floor = between(rng, 0.04, 0.3);
      drop.gain.setValueAtTime(1, t);
      drop.gain.linearRampToValueAtTime(floor, t + 0.004);
      drop.gain.setValueAtTime(floor, t + len);
      drop.gain.linearRampToValueAtTime(1, t + len + 0.004);
    }

    const peak = cfg.voiceLevel * between(rng, 0.55, 1) * (0.6 + 0.4 * clarity);
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(peak, start + 0.008);
    level.gain.setValueAtTime(peak, start + Math.max(0.01, playLen - 0.015));
    level.gain.linearRampToValueAtTime(0, start + playLen);

    let t = start;
    let last: AudioBufferSourceNode | undefined;
    for (const seg of segments) {
      const src = ctx.createBufferSource();
      src.buffer = seg.buffer;
      src.playbackRate.value = rate;
      src.connect(chain.input);
      src.start(t, seg.offset, seg.duration);
      t += seg.duration / rate;
      last = src;
    }
    if (last) last.onended = () => window.setTimeout(() => level.disconnect(), 200);

    this.sweep.duck(start, start + playLen, 0.5 + 0.4 * clarity);
    return { start, duration: playLen };
  }

  event(plan: EventPlan, earliest = this.engine.now + 0.03): Rendered {
    switch (plan.event) {
      case 'knock':
        return this.knock(earliest);
      case 'breath':
        return this.breath(earliest);
      case 'carrier':
        return this.carrier(earliest);
      default:
        return this.tone(earliest);
    }
  }

  private segments(plan: VoicePlan, take: Take): Segment[] {
    const rng = this.rng;
    const buf = this.bank.buffer;
    switch (plan.form) {
      case 'partial': {
        const frac = between(rng, 0.45, 0.75);
        const dur = take.duration * frac;
        return [{ buffer: buf, offset: plan.keepStart ? take.start : take.start + take.duration - dur, duration: dur }];
      }
      case 'syllable': {
        const dur = Math.min(take.duration, between(rng, 0.08, 0.17));
        return [{ buffer: buf, offset: take.start + rng.next() * (take.duration - dur), duration: dur }];
      }
      case 'pseudo': {
        const other = plan.splice ? pick(rng, this.bank.byEntry.get(plan.splice.id) ?? [take]) : take;
        const a = take.duration * between(rng, 0.4, 0.6);
        const b = other.duration * between(rng, 0.4, 0.6);
        return [
          { buffer: buf, offset: take.start, duration: a },
          { buffer: buf, offset: other.start + other.duration - b, duration: b },
        ];
      }
      case 'unintelligible': {
        if (chance(rng, 0.6)) return [{ buffer: this.bank.reversed, offset: reversedStart(this.bank, take), duration: take.duration }];
        const dur = take.duration * between(rng, 0.5, 0.9);
        return [{ buffer: buf, offset: take.start + rng.next() * (take.duration - dur), duration: dur }];
      }
      default:
        return [{ buffer: buf, offset: take.start, duration: take.duration }];
    }
  }

  private knock(earliest: number): Rendered {
    const ctx = this.engine.ctx;
    const rng = this.rng;
    const n = intBetween(rng, 1, 3);
    const spacing = between(rng, 0.22, 0.42);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = between(rng, 500, 900);
    const out = ctx.createGain();
    out.gain.value = 0.9 * this.config().spiritBox.audio.voiceLevel;
    lp.connect(out).connect(this.engine.buses.event);
    const start = earliest;
    for (let i = 0; i < n; i++) {
      const t = start + i * spacing * between(rng, 0.9, 1.1);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(between(rng, 90, 130), t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(between(rng, 0.5, 1), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + 0.16);
      const nz = ctx.createBufferSource();
      nz.buffer = this.engine.noise;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.4, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      nz.connect(ng).connect(lp);
      nz.start(t, rng.next() * 2, 0.04);
    }
    const duration = (n - 1) * spacing + 0.18;
    window.setTimeout(() => out.disconnect(), (duration + start - ctx.currentTime + 0.5) * 1000);
    return { start, duration };
  }

  private breath(earliest: number): Rendered {
    const ctx = this.engine.ctx;
    const rng = this.rng;
    const start = this.sweep.isRunning ? this.sweep.nextBoundary(earliest) : earliest;
    const dur = between(rng, 0.6, 1.3);
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(between(rng, 700, 1000), start);
    bp.frequency.linearRampToValueAtTime(between(rng, 1300, 1900), start + dur);
    const g = ctx.createGain();
    const lvl = 0.35 * this.config().spiritBox.audio.voiceLevel;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(lvl, start + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, start + dur);
    src.connect(bp).connect(g).connect(this.engine.buses.voice);
    src.start(start, rng.next() * 1.5, dur + 0.05);
    src.onended = () => g.disconnect();
    this.sweep.duck(start, start + dur, 0.55);
    return { start, duration: dur };
  }

  /** "Dead air": the hiss collapses for a moment, leaving faint hum. */
  private carrier(earliest: number): Rendered {
    const ctx = this.engine.ctx;
    const rng = this.rng;
    const start = this.sweep.isRunning ? this.sweep.nextBoundary(earliest) : earliest;
    const dur = between(rng, 0.6, 1.5);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = chance(rng, 0.5) ? 60 : 50;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.05, start + 0.02);
    g.gain.setValueAtTime(0.05, start + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(lp).connect(g).connect(this.engine.buses.event);
    o.start(start);
    o.stop(start + dur + 0.05);
    o.onended = () => g.disconnect();
    this.sweep.duck(start, start + dur, 0.94);
    return { start, duration: dur };
  }

  private tone(earliest: number): Rendered {
    const ctx = this.engine.ctx;
    const rng = this.rng;
    const start = this.sweep.isRunning ? this.sweep.nextBoundary(earliest) : earliest;
    const dur = between(rng, 0.15, 0.4);
    const o = ctx.createOscillator();
    o.frequency.value = between(rng, 600, 2400);
    const vib = ctx.createOscillator();
    vib.frequency.value = between(rng, 4, 7);
    const vg = ctx.createGain();
    vg.gain.value = o.frequency.value * 0.01;
    vib.connect(vg).connect(o.frequency);
    const chain = radioChain(ctx, { highpass: 300, lowpass: 3000, presence: 1500, distortion: 0.5 });
    const g = ctx.createGain();
    const lvl = 0.16 * this.config().spiritBox.audio.voiceLevel;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(lvl, start + 0.01);
    g.gain.setValueAtTime(lvl, start + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(chain.input);
    chain.output.connect(g).connect(this.engine.buses.event);
    o.start(start);
    vib.start(start);
    o.stop(start + dur + 0.05);
    vib.stop(start + dur + 0.05);
    o.onended = () => g.disconnect();
    this.sweep.duck(start, start + dur, 0.4);
    return { start, duration: dur };
  }
}
