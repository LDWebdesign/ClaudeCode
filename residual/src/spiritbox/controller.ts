/**
 * Spirit box: wires the listener, question memory, correlation engine, response scheduler
 * and audio renderer together, and writes what happens to the investigation log.
 */
import type { AudioEngine } from '../audio/engine';
import { FragmentRenderer } from '../audio/fragments';
import { Sweep } from '../audio/sweep';
import type { VoiceBank } from '../audio/voicebank';
import type { ConfigStore } from '../config';
import type { Session } from '../session/session';
import { Emitter } from '../util/emitter';
import { type Rng, inRange, mathRng } from '../util/rng';
import { analyze } from './concepts';
import { CorrelationEngine, type FragmentPlan } from './correlation';
import { describeTier, interpret } from './interpretation';
import type { Listener } from './listener';
import { QuestionMemory } from './memory';
import { type FireCause, ResponseScheduler } from './scheduler';

export interface SpiritBoxEvents extends Record<string, unknown> {
  /** a fragment is about to be audible (ctx time) — for the VOX lamp and signal meter */
  fragment: { plan: FragmentPlan; start: number; duration: number; cause: FireCause };
  scanning: { on: boolean };
}

const NO_RESPONSE_AFTER_SEC = 24;

export class SpiritBox extends Emitter<SpiritBoxEvents> {
  readonly sweep: Sweep;
  readonly memory = new QuestionMemory();
  readonly correlation: CorrelationEngine;
  private renderer?: FragmentRenderer;
  private scheduler: ResponseScheduler;
  private session?: Session;
  private tickTimer?: number;
  private lastFragmentAt = -Infinity;
  private unsub: (() => void)[] = [];

  constructor(
    private readonly engine: AudioEngine,
    private readonly config: ConfigStore,
    private readonly listener: Listener,
    private readonly rng: Rng = mathRng,
  ) {
    super();
    const cfg = () => this.config.value;
    this.sweep = new Sweep(engine, cfg, rng);
    this.correlation = new CorrelationEngine(cfg, rng);
    this.scheduler = new ResponseScheduler(cfg, this.correlation, this.memory, rng, {
      fire: (plan, cause) => this.fire(plan, cause),
      decided: (d) => {
        if (this.config.value.diagnostics && this.session) {
          const ev = this.session.findByUtterance(d.utteranceId);
          if (ev) this.session.update(ev.id, { meta: { ...ev.meta, decision: d.kind, ...(d.kind === 'scheduled' ? { delay: +d.delay.toFixed(1) } : {}) } });
        }
      },
    });
    this.scheduler.paused = true;
  }

  setBank(bank: VoiceBank): void {
    this.sweep.setBank(bank);
    this.renderer = new FragmentRenderer(this.engine, this.sweep, bank, () => this.config.value, this.rng);
  }

  get ready(): boolean {
    return !!this.renderer;
  }

  get scanning(): boolean {
    return this.sweep.isRunning;
  }

  attach(session: Session): void {
    this.detach();
    this.session = session;
    this.memory.clear();
    this.correlation.resetSession();
    this.scheduler.reset(session.clock());
    this.unsub.push(
      this.listener.on('speechstart', () => this.scheduler.onSpeechStart(session.clock())),
      this.listener.on('utterance', (u) => this.onUtterance(u.id, u.at, u.text, u.durationSec)),
      this.listener.on('amend', ({ id, text }) => this.onAmend(id, text)),
    );
    this.tickTimer = window.setInterval(() => this.scheduler.tick(session.clock()), 100);
  }

  detach(): void {
    this.unsub.forEach((u) => u());
    this.unsub = [];
    window.clearInterval(this.tickTimer);
    this.setScanning(false);
    this.session = undefined;
  }

  setScanning(on: boolean): void {
    if (on === this.sweep.isRunning) return;
    if (on) {
      this.sweep.start();
      this.scheduler.paused = false;
    } else {
      this.sweep.stop();
      this.scheduler.paused = true;
      if (this.session) this.scheduler.reset(this.session.clock());
    }
    this.emit('scanning', { on });
  }

  /** A typed question (when speaking isn't possible). */
  ask(text: string): void {
    this.listener.inject(text);
  }

  private onUtterance(id: string, at: number, text: string | null, durationSec: number): void {
    const session = this.session;
    if (!session) return;
    const analysis = analyze(text ?? '');
    if (text === null) analysis.isQuestion = true; // untranscribed speech is treated as a question
    const ev = session.log({
      t: session.epoch(at),
      type: analysis.isQuestion ? 'question' : 'remark',
      mode: 'spiritbox',
      title: analysis.isQuestion ? 'Question' : 'Investigator',
      text: text ?? undefined,
      detail: text === null ? `${durationSec.toFixed(1)} s` : undefined,
      utteranceId: id,
      meta: this.config.value.diagnostics ? { concepts: Object.fromEntries([...analysis.concepts].map(([k, v]) => [k, +v.toFixed(2)])), answer: analysis.answer } : undefined,
    });

    if (!this.scanning) {
      // still remembered: it can surface later, once scanning resumes
      this.memory.add({ id, at, analysis });
      return;
    }
    this.scheduler.onUtterance(at, { id, at, analysis });

    // If nothing at all comes back, say so — the way a field log would.
    window.setTimeout(() => {
      if (!this.session || this.lastFragmentAt > at) return;
      const current = this.session.events.find((e) => e.id === ev.id);
      if (current && !current.detail?.includes('No response')) {
        this.session.update(ev.id, { detail: current.detail ? `${current.detail} · No response` : 'No response' });
      }
    }, NO_RESPONSE_AFTER_SEC * 1000);
  }

  private onAmend(id: string, text: string): void {
    const session = this.session;
    if (!session) return;
    const ev = session.findByUtterance(id);
    if (!ev) return;
    const analysis = analyze(text);
    session.update(ev.id, { text, detail: ev.detail?.includes('No response') ? 'No response' : undefined });
    // Fold the late transcript into memory so later fragments can relate to it.
    const existing = this.memory.all.find((u) => u.id === id);
    if (existing) existing.analysis = analysis;
  }

  private fire(plan: FragmentPlan, cause: FireCause): number {
    const session = this.session;
    if (!session || !this.renderer) return 0;
    const r = plan.type === 'voice' ? this.renderer.voice(plan) : this.renderer.event(plan);
    const lead = Math.max(0, r.start - this.engine.now);
    const startSession = session.clock() + lead;
    this.lastFragmentAt = startSession;
    this.listener.suppress(startSession + r.duration + 0.4, plan.type === 'voice' ? plan.entry.text : undefined);
    this.emit('fragment', { plan, start: r.start, duration: r.duration, cause });

    const cfg = this.config.value;
    const it = interpret(plan, r.duration, cfg, this.rng);
    const diagnostics = cfg.diagnostics;
    const meta = {
      tier: plan.tier,
      cause,
      reason: describeTier(plan),
      ...(plan.type === 'voice' ? { entry: plan.entry.text, form: plan.form, clarity: +plan.clarity.toFixed(2) } : { event: plan.event }),
    };
    const freq = this.sweep.current(r.start);
    const detail = freq ? `${it.detail} · ${this.sweep.formatFreq(freq.freq)} ${this.config.value.spiritBox.sweep.band === 'FM' ? 'MHz' : 'kHz'}` : it.detail;

    // The log entry appears a moment after the sound, as if it had just been reviewed.
    window.setTimeout(() => {
      if (this.session !== session) return;
      session.log({
        t: session.epoch(startSession),
        type: plan.type === 'event' ? 'audio-event' : 'fragment',
        mode: 'spiritbox',
        title: it.title,
        text: it.reading,
        alternates: it.alternates.length ? it.alternates : undefined,
        detail,
        hidden: !it.logged,
        meta: diagnostics || !it.logged ? meta : undefined,
      });
    }, (r.duration + inRange(this.rng, cfg.spiritBox.log.interpretDelaySec)) * 1000);

    return r.duration + lead;
  }
}
