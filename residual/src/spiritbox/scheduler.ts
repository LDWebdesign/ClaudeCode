/**
 * Response timing. Decides whether an utterance gets a response at all, and when.
 *
 * Responses are scheduled, but what they contain is decided only when they fire (from
 * decaying memory), so a delayed response may relate to something other than the question
 * that scheduled it. Fragments can also arrive mid-sentence, in short bursts, or unprompted
 * during long silences.
 */
import type { ResidualConfig } from '../config';
import { type Rng, between, chance, inRange, pickBy } from '../util/rng';
import type { CorrelationEngine, FragmentPlan } from './correlation';
import type { QuestionMemory, Utterance } from './memory';

export type FireCause = 'response' | 'interrupt' | 'burst' | 'spontaneous';

export interface Pending {
  at: number;
  cause: FireCause;
  utteranceId?: string;
}

export type Decision =
  | { kind: 'silence'; utteranceId: string; reason: string }
  | { kind: 'scheduled'; utteranceId: string; at: number; delay: number }
  | { kind: 'absorbed'; utteranceId: string; reason: string };

export interface SchedulerHooks {
  /** plays the plan; returns its duration in seconds */
  fire(plan: FragmentPlan, cause: FireCause, at: number): number;
  decided?(decision: Decision): void;
}

export class ResponseScheduler {
  private pending: Pending[] = [];
  private lastFragmentEnd = -Infinity;
  private lastSpeechEnd: number;
  private speaking = false;
  private lastTick: number;
  paused = false;

  constructor(
    private readonly config: () => ResidualConfig,
    private readonly engine: CorrelationEngine,
    private readonly memory: QuestionMemory,
    private readonly rng: Rng,
    private readonly hooks: SchedulerHooks,
    now = 0,
  ) {
    this.lastSpeechEnd = now;
    this.lastTick = now;
  }

  get queue(): readonly Pending[] {
    return this.pending;
  }

  reset(now: number): void {
    this.pending = [];
    this.lastFragmentEnd = -Infinity;
    this.lastSpeechEnd = now;
    this.lastTick = now;
  }

  onSpeechStart(now: number): void {
    this.speaking = true;
    const cfg = this.config().spiritBox.response;
    // Occasionally a waiting response lands over the investigator's voice.
    for (const p of this.pending) {
      if (p.at - now < 12 && chance(this.rng, cfg.interruptChance)) {
        p.at = now + between(this.rng, 0.4, 1.8);
        p.cause = 'interrupt';
      }
    }
  }

  onUtterance(now: number, u: Utterance): Decision {
    this.speaking = false;
    this.lastSpeechEnd = now;
    this.memory.add(u);
    const cfg = this.config().spiritBox.response;

    let silence = cfg.silenceChance;
    if (!u.analysis.isQuestion) silence += 0.2;
    if (now - this.lastFragmentEnd < 6) silence += 0.15;
    if (now - this.lastFragmentEnd > 180) silence -= 0.1;

    let decision: Decision;
    if (chance(this.rng, Math.min(0.95, Math.max(0, silence)))) {
      decision = { kind: 'silence', utteranceId: u.id, reason: 'no response drawn' };
    } else if (this.pending.some((p) => p.cause !== 'burst') && chance(this.rng, 0.35)) {
      // A response is already on its way; it will be drawn from memory that now includes this question.
      decision = { kind: 'absorbed', utteranceId: u.id, reason: 'earlier response still pending' };
    } else {
      const band = pickBy(this.rng, cfg.delays, (d) => d.weight);
      const delay = (band ? inRange(this.rng, band.range) : 6) * Math.max(0.1, cfg.delayScale);
      const at = now + delay;
      this.pending.push({ at, cause: 'response', utteranceId: u.id });
      if (this.pending.length > 3) this.pending.shift();
      decision = { kind: 'scheduled', utteranceId: u.id, at, delay };
    }
    this.hooks.decided?.(decision);
    return decision;
  }

  /** Call regularly (e.g. every 100 ms) with the session clock in seconds. */
  tick(now: number): void {
    const dt = Math.max(0, Math.min(1, now - this.lastTick));
    this.lastTick = now;
    if (this.paused) return;
    const cfg = this.config().spiritBox.response;

    const due = this.pending.filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
    if (due.length) {
      const next = due[0];
      const sinceLast = now - this.lastFragmentEnd;
      if (next.cause !== 'burst' && sinceLast < cfg.minGapSec) {
        // Too soon after the previous fragment; let it slip a little.
        for (const p of due) p.at = now + (cfg.minGapSec - sinceLast) + between(this.rng, 0.2, 2.5);
        return;
      }
      this.pending = this.pending.filter((p) => p !== next);
      this.fireNow(now, next.cause);
      return;
    }

    // Unprompted fragments during long silences (Poisson process).
    const silentFor = now - this.lastSpeechEnd;
    if (
      !this.speaking &&
      !this.pending.length &&
      silentFor > cfg.spontaneousAfterSilenceSec &&
      now - this.lastFragmentEnd > cfg.minGapSec * 2
    ) {
      const rate = cfg.spontaneousPerMinute / 60;
      if (chance(this.rng, 1 - Math.exp(-rate * dt))) this.fireNow(now, 'spontaneous');
    }
  }

  private fireNow(now: number, cause: FireCause): void {
    const plan = this.engine.plan(now, this.memory, { spontaneous: cause === 'spontaneous' });
    const duration = this.hooks.fire(plan, cause, now);
    if (plan.type === 'voice') this.engine.markPlayed(plan.entry.id, now);
    this.lastFragmentEnd = now + duration;
    const cfg = this.config().spiritBox.response;
    if (cause !== 'burst' && chance(this.rng, cfg.burstChance)) {
      this.pending.push({ at: now + duration + between(this.rng, 0.25, 1.4), cause: 'burst' });
    }
  }
}
