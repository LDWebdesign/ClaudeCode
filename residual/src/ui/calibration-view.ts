/** Calibration sheet: every tunable in config.ts, grouped, with live effect. */
import type { ConfigStore, ResidualConfig } from '../config';
import { h, icon } from './dom';

type Get = (c: ResidualConfig) => number;
type Set = (c: ResidualConfig, v: number) => void;

interface RangeCtl {
  kind: 'range';
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  get: Get;
  set: Set;
  fmt: (v: number) => string;
}
interface ToggleCtl {
  kind: 'toggle';
  label: string;
  hint?: string;
  get: (c: ResidualConfig) => boolean;
  set: (c: ResidualConfig, v: boolean) => void;
}
interface WeightsCtl {
  kind: 'weights';
  label: string;
  hint?: string;
  keys: string[];
  names: string[];
  get: (c: ResidualConfig) => Record<string, number>;
}
type Ctl = RangeCtl | ToggleCtl | WeightsCtl;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} s`;
const times = (v: number) => `${v.toFixed(2)}×`;
const num = (v: number) => v.toFixed(2);
const r = (label: string, min: number, max: number, step: number, get: Get, set: Set, fmt = num, hint?: string): RangeCtl => ({ kind: 'range', label, min, max, step, get, set, fmt, hint });

const GROUPS: { title: string; intro?: string; ctls: Ctl[] }[] = [
  {
    title: 'Spirit box · correlation',
    intro: 'How a fragment relates to what was asked. Relevance is drawn from decaying memory when a fragment plays, so it can relate to an earlier question rather than the last one.',
    ctls: [
      { kind: 'weights', label: 'Relationship to questions', keys: ['unrelated', 'loose', 'relevant', 'uncanny'], names: ['Unrelated', 'Loosely associated', 'Noticeably relevant', 'Uncanny'], get: (c) => c.spiritBox.correlation.weights },
      r('Memory half-life', 10, 300, 5, (c) => c.spiritBox.correlation.memoryHalfLifeSec, (c, v) => (c.spiritBox.correlation.memoryHalfLifeSec = v), sec, 'How long a question keeps influencing fragments.'),
      r('Recency bias', 0, 1, 0.05, (c) => c.spiritBox.correlation.recencyBias, (c, v) => (c.spiritBox.correlation.recencyBias = v), pct, 'Preference for the latest question over earlier ones.'),
      r('Delayed echo', 0, 1, 0.05, (c) => c.spiritBox.correlation.delayedEchoChance, (c, v) => (c.spiritBox.correlation.delayedEchoChance = v), pct, 'Within the uncanny tier: chance of repeating a word from an older question.'),
    ],
  },
  {
    title: 'Spirit box · timing',
    ctls: [
      r('No response', 0, 0.9, 0.01, (c) => c.spiritBox.response.silenceChance, (c, v) => (c.spiritBox.response.silenceChance = v), pct, 'Chance a question gets nothing back.'),
      r('Response latency', 0.3, 3, 0.05, (c) => c.spiritBox.response.delayScale, (c, v) => (c.spiritBox.response.delayScale = v), times, 'Scales the 1–3 s / 5–8 s / 10–16 s / 18–40 s delay bands.'),
      r('Lands while speaking', 0, 0.4, 0.01, (c) => c.spiritBox.response.interruptChance, (c, v) => (c.spiritBox.response.interruptChance = v), pct),
      r('Short bursts', 0, 0.4, 0.01, (c) => c.spiritBox.response.burstChance, (c, v) => (c.spiritBox.response.burstChance = v), pct),
      r('Unprompted fragments', 0, 2, 0.02, (c) => c.spiritBox.response.spontaneousPerMinute, (c, v) => (c.spiritBox.response.spontaneousPerMinute = v), (v) => `${v.toFixed(2)}/min`, 'During long silences.'),
      r('Minimum gap', 0.5, 15, 0.5, (c) => c.spiritBox.response.minGapSec, (c, v) => (c.spiritBox.response.minGapSec = v), sec),
      r('Non-vocal events', 0, 0.4, 0.01, (c) => c.spiritBox.response.audioEventChance, (c, v) => (c.spiritBox.response.audioEventChance = v), pct, 'Knocks, breath-like noise, dead air.'),
    ],
  },
  {
    title: 'Spirit box · fragments',
    ctls: [
      { kind: 'weights', label: 'Fragment form', keys: ['word', 'partial', 'syllable', 'pseudo', 'unintelligible'], names: ['Whole word', 'Cut off', 'Syllable', 'Word-like', 'Unintelligible'], get: (c) => c.spiritBox.forms },
      r('Repetition cooldown', 0, 150, 5, (c) => c.spiritBox.repetition.cooldownFragments, (c, v) => (c.spiritBox.repetition.cooldownFragments = v), (v) => `${v} fragments`),
      r('Interpret above clarity', 0, 1, 0.01, (c) => c.spiritBox.log.interpretClarity, (c, v) => (c.spiritBox.log.interpretClarity = v), pct, 'Below this, the log records a signal without a reading.'),
      r('Unlogged faint fragments', 0, 1, 0.01, (c) => c.spiritBox.log.unloggedLowClarityChance, (c, v) => (c.spiritBox.log.unloggedLowClarityChance = v), pct, 'Only audible on the recording.'),
    ],
  },
  {
    title: 'Spirit box · signal',
    ctls: [
      r('Sweep step', 50, 350, 5, (c) => c.spiritBox.sweep.stepMs, (c, v) => (c.spiritBox.sweep.stepMs = v), (v) => `${v} ms`),
      r('Step jitter', 0, 0.8, 0.01, (c) => c.spiritBox.sweep.stepJitter, (c, v) => (c.spiritBox.sweep.stepJitter = v), pct),
      r('Static', 0, 1, 0.01, (c) => c.spiritBox.audio.staticLevel, (c, v) => (c.spiritBox.audio.staticLevel = v), pct),
      r('Voice level', 0, 1, 0.01, (c) => c.spiritBox.audio.voiceLevel, (c, v) => (c.spiritBox.audio.voiceLevel = v), pct),
      r('Distortion', 0, 1, 0.01, (c) => c.spiritBox.audio.distortion, (c, v) => (c.spiritBox.audio.distortion = v), pct),
      r('Clarity', 0, 1, 0.01, (c) => c.spiritBox.audio.clarity, (c, v) => (c.spiritBox.audio.clarity = v), pct, 'Bandwidth, dropouts and flutter on vocal fragments.'),
      r('Broadcast bleed', 0, 1, 0.01, (c) => c.spiritBox.audio.radioBleed, (c, v) => (c.spiritBox.audio.radioBleed = v), pct, 'Snatches of distant stations in the sweep.'),
    ],
  },
  {
    title: 'Listening',
    ctls: [
      r('Speech threshold', 4, 24, 0.5, (c) => c.spiritBox.listener.vadThresholdDb, (c, v) => (c.spiritBox.listener.vadThresholdDb = v), (v) => `+${v.toFixed(1)} dB`, 'Above the room’s noise floor.'),
      r('End of speech after', 300, 1500, 25, (c) => c.spiritBox.listener.vadReleaseMs, (c, v) => (c.spiritBox.listener.vadReleaseMs = v), (v) => `${v} ms`),
      { kind: 'toggle', label: 'Transcribe speech', hint: 'Uses the browser’s speech service, which may process audio online. Without it, questions are still detected and logged.', get: (c) => c.spiritBox.listener.transcription, set: (c, v) => (c.spiritBox.listener.transcription = v) },
    ],
  },
  {
    title: 'Visual · frequency',
    intro: 'Each completed scan rolls this table once. Anything other than normal still needs a steady camera and a believable, persistent location, and is followed by a quiet period.',
    ctls: [
      { kind: 'weights', label: 'Scan outcome', keys: ['normal', 'subtle', 'unusual', 'uncanny'], names: ['Normal', 'Very subtle', 'Unusual shadow / shape', 'Partial figure'], get: (c) => c.camera.tiers },
      r('Scan length', 3, 30, 0.5, (c) => (c.camera.scanIntervalSec[0] + c.camera.scanIntervalSec[1]) / 2, (c, v) => (c.camera.scanIntervalSec = [+(v * 0.8).toFixed(1), +(v * 1.25).toFixed(1)]), sec),
      r('Dormant stretches', 0, 0.3, 0.01, (c) => c.camera.dormancyChance, (c, v) => (c.camera.dormancyChance = v), pct, 'Chance after a normal scan of 2–5 minutes with nothing at all.'),
      r('Few-frame anomalies', 0, 1, 0.01, (c) => c.camera.footageOnlyChance, (c, v) => (c.camera.footageOnlyChance = v), pct, 'Lasting 2–3 frames: mostly visible when reviewing footage.'),
      r('Logged · subtle', 0, 1, 0.01, (c) => c.camera.logChance.subtle, (c, v) => (c.camera.logChance.subtle = v), pct),
      r('Logged · unusual', 0, 1, 0.01, (c) => c.camera.logChance.unusual, (c, v) => (c.camera.logChance.unusual = v), pct),
      r('Logged · uncanny', 0, 1, 0.01, (c) => c.camera.logChance.uncanny, (c, v) => (c.camera.logChance.uncanny = v), pct),
    ],
  },
  {
    title: 'Visual · appearance',
    ctls: [
      r('Visibility', 0, 1, 0.01, (c) => c.camera.visibility, (c, v) => (c.camera.visibility = v), pct),
      r('Movement', 0, 1, 0.01, (c) => c.camera.movement, (c, v) => (c.camera.movement = v), pct),
      r('Detection sensitivity', 0, 1, 0.01, (c) => c.camera.detection.sensitivity, (c, v) => (c.camera.detection.sensitivity = v), pct, 'How readily doorways, edges and dark regions are found.'),
      r('Steadiness required', 0, 1, 0.01, (c) => c.camera.detection.stillnessRequired, (c, v) => (c.camera.detection.stillnessRequired = v), pct),
      r('Location persistence', 1, 12, 1, (c) => c.camera.detection.minPersistence, (c, v) => (c.camera.detection.minPersistence = v), (v) => `${v} scans`),
      r('Grain', 0, 1, 0.01, (c) => c.camera.image.grain, (c, v) => (c.camera.image.grain = v), pct),
      r('Colour', 0, 1, 0.01, (c) => c.camera.image.saturation, (c, v) => (c.camera.image.saturation = v), pct),
    ],
  },
  {
    title: 'Diagnostics',
    ctls: [
      { kind: 'toggle', label: 'Show engine decisions', hint: 'Reveals detected locations, engine-only events and the reasoning behind each fragment. Spoils the effect; for tuning.', get: (c) => c.diagnostics, set: (c, v) => (c.diagnostics = v) },
    ],
  },
];

export class CalibrationView {
  readonly el: HTMLElement;
  private refreshers: (() => void)[] = [];

  constructor(private readonly config: ConfigStore) {
    const body = h('div.sheet-inner');
    for (const g of GROUPS) {
      const sec = h('section.cal-group', null, h('h3', null, g.title), g.intro ? h('p', null, g.intro) : null);
      for (const c of g.ctls) sec.append(this.control(c));
      body.append(sec);
    }
    body.append(
      h('div.cal-actions', null, h('button.btn', { type: 'button', onclick: () => this.config.reset() }, 'Reset to defaults')),
      h('div.about', null,
        h('p', null, 'Residual is an investigation experience. Its spirit-box fragments are drawn from a synthesized voice bank and its visual irregularities are rendered into the camera image by probability engines you can tune here.'),
        h('p', null, 'It cannot detect anything paranormal, and nothing it produces is evidence. Sessions, recordings and settings stay on this device.'),
      ),
    );
    this.el = h('section.sheet', { hidden: true, role: 'dialog', 'aria-label': 'Calibration' },
      h('header.sheet-head', null, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => (this.el.hidden = true) }, icon('back')), h('h2', null, 'Calibration')),
      h('div.sheet-body', null, body),
    );
    this.config.subscribe(() => this.refreshers.forEach((f) => f()));
  }

  open(): void {
    this.refreshers.forEach((f) => f());
    this.el.hidden = false;
  }

  private control(c: Ctl): HTMLElement {
    if (c.kind === 'toggle') {
      const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-label': c.label, onclick: () => this.config.update((d) => c.set(d, !c.get(d))) });
      this.refreshers.push(() => sw.setAttribute('aria-checked', String(c.get(this.config.value))));
      return h('div.cal-row.toggle', null, h('span.name', null, c.label), sw, c.hint ? h('span.hint', null, c.hint) : null);
    }
    if (c.kind === 'range') {
      const val = h('span.val');
      const input = h('input', { type: 'range', min: c.min, max: c.max, step: c.step, 'aria-label': c.label }) as HTMLInputElement;
      input.addEventListener('input', () => this.config.update((d) => c.set(d, Number(input.value))));
      this.refreshers.push(() => {
        const v = c.get(this.config.value);
        if (document.activeElement !== input) input.value = String(v);
        val.textContent = c.fmt(v);
      });
      return h('div.cal-row', null, h('span.name', null, c.label), val, c.hint ? h('span.hint', null, c.hint) : null, input);
    }
    // weights
    const wrap = h('div.cal-row', null, h('span.name', null, c.label), h('span'));
    const bar = h('div.cal-split', { style: `grid-template-columns:repeat(${c.keys.length},1fr)` });
    const cells = c.keys.map(() => h('i'));
    bar.append(...cells);
    wrap.append(h('span.hint', null, c.hint ?? 'Relative weights; shares shown on the right.'), bar);
    const rows = c.keys.map((k, i) => {
      const val = h('span.val');
      const input = h('input', { type: 'range', min: 0, max: 100, step: 0.5, 'aria-label': `${c.label}: ${c.names[i]}` }) as HTMLInputElement;
      input.addEventListener('input', () => this.config.update((d) => ((c.get(d) as Record<string, number>)[k] = Number(input.value))));
      const row = h('div.cal-row', { style: 'padding-left:12px' }, h('span.name', { style: 'font-size:13px;color:var(--text-2)' }, c.names[i]), val, input);
      return { k, row, val, input };
    });
    this.refreshers.push(() => {
      const w = c.get(this.config.value);
      const total = c.keys.reduce((s, k) => s + Math.max(0, w[k] ?? 0), 0) || 1;
      bar.style.gridTemplateColumns = c.keys.map((k) => `${Math.max(0.0001, w[k] ?? 0)}fr`).join(' ');
      for (const r of rows) {
        if (document.activeElement !== r.input) r.input.value = String(w[r.k]);
        r.val.textContent = `${((100 * (w[r.k] ?? 0)) / total).toFixed((w[r.k] ?? 0) / total < 0.1 ? 1 : 0)}%`;
      }
    });
    return h('div', null, wrap, ...rows.map((r) => r.row));
  }
}
