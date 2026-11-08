import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ResidualConfig, cloneConfig } from '../src/config';
import { analyze } from '../src/spiritbox/concepts';
import { CorrelationEngine, type FragmentPlan } from '../src/spiritbox/correlation';
import { interpret } from '../src/spiritbox/interpretation';
import { QuestionMemory } from '../src/spiritbox/memory';
import { ResponseScheduler, type Decision } from '../src/spiritbox/scheduler';
import { VOCAB } from '../src/spiritbox/vocabulary';
import { seededRng } from '../src/util/rng';

const cfg = (mut?: (c: ResidualConfig) => void) => {
  const c = cloneConfig(DEFAULT_CONFIG);
  mut?.(c);
  return () => c;
};

describe('question analysis', () => {
  it('extracts death and place concepts from "Did you die here?"', () => {
    const a = analyze('Did you die here?');
    expect(a.isQuestion).toBe(true);
    expect(a.answer).toBe('yesno');
    expect(a.concepts.get('death')).toBeGreaterThan(0.5);
    expect(a.concepts.has('presence') || a.concepts.has('place')).toBe(true);
  });

  it('recognises answer types and inflections', () => {
    expect(analyze('what is your name').answer).toBe('who');
    expect(analyze('how old are you').answer).toBe('howmany');
    expect(analyze('where are you').answer).toBe('where');
    expect(analyze('did somebody die in the basement').concepts.has('below')).toBe(true);
    expect(analyze('are you trapped here').concepts.has('stay')).toBe(true);
    expect(analyze('it is getting cold in here').isQuestion).toBe(false);
  });
});

describe('vocabulary', () => {
  it('is large and has unique entries', () => {
    expect(VOCAB.length).toBeGreaterThan(400);
    expect(new Set(VOCAB.map((v) => v.text.toLowerCase())).size).toBe(VOCAB.length);
  });
});

function simulate(questions: string[], n: number, seed = 7) {
  const rng = seededRng(seed);
  const engine = new CorrelationEngine(cfg(), rng);
  const memory = new QuestionMemory();
  const tiers: Record<string, number> = {};
  const plans: FragmentPlan[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += 15;
    if (i % 3 === 0) {
      const q = questions[(i / 3) % questions.length];
      memory.add({ id: `u${i}`, at: t - 2, analysis: analyze(q) });
    }
    const plan = engine.plan(t, memory);
    if (plan.type === 'voice') engine.markPlayed(plan.entry.id, t);
    tiers[plan.tier] = (tiers[plan.tier] ?? 0) + 1;
    plans.push(plan);
  }
  return { tiers, plans };
}

describe('correlation engine', () => {
  const questions = ['Is anyone here?', 'Did you die here?', 'What is your name?', 'Are you a man?', 'Do you want us to leave?'];

  it('follows the configured 65/25/9/1 tier distribution', () => {
    const n = 20000;
    const { tiers } = simulate(questions, n);
    const share = (k: string) => (tiers[k] ?? 0) / n;
    expect(share('unrelated')).toBeGreaterThan(0.6);
    expect(share('unrelated')).toBeLessThan(0.7);
    expect(share('loose')).toBeGreaterThan(0.21);
    expect(share('loose')).toBeLessThan(0.29);
    expect(share('relevant')).toBeGreaterThan(0.07);
    expect(share('relevant')).toBeLessThan(0.11);
    expect(share('uncanny')).toBeGreaterThan(0.004);
    expect(share('uncanny')).toBeLessThan(0.02);
  });

  it('never repeats an entry within the cooldown window', () => {
    const { plans } = simulate(questions, 3000, 11);
    const ids = plans.filter((p) => p.type === 'voice').map((p) => (p.type === 'voice' ? p.entry.id : -1));
    for (let i = 0; i < ids.length; i++) {
      const window = ids.slice(Math.max(0, i - 40), i);
      expect(window.includes(ids[i])).toBe(false);
    }
    // and uses a broad slice of the vocabulary
    expect(new Set(ids).size).toBeGreaterThan(300);
  });

  it('keeps unrelated fragments away from the active topic', () => {
    const rng = seededRng(3);
    const engine = new CorrelationEngine(cfg((c) => (c.spiritBox.correlation.weights = { unrelated: 1, loose: 0, relevant: 0, uncanny: 0 })), rng);
    const memory = new QuestionMemory();
    memory.add({ id: 'q', at: 0, analysis: analyze('Did you die here?') });
    for (let i = 0; i < 400; i++) {
      const p = engine.plan(1 + i * 0.01, memory);
      if (p.type === 'voice') expect(p.entry.tags.includes('death')).toBe(false);
    }
  });

  it('relevant tier draws from the question topic', () => {
    const rng = seededRng(5);
    const engine = new CorrelationEngine(
      cfg((c) => {
        c.spiritBox.correlation.weights = { unrelated: 0, loose: 0, relevant: 1, uncanny: 0 };
        c.spiritBox.response.audioEventChance = 0;
      }),
      rng,
    );
    const memory = new QuestionMemory();
    memory.add({ id: 'q', at: 0, analysis: analyze('Did you die in the basement?') });
    let onTopic = 0;
    for (let i = 0; i < 200; i++) {
      const p = engine.plan(1, memory);
      if (p.type === 'voice' && p.concept && p.entry.tags.includes(p.concept)) onTopic++;
    }
    expect(onTopic).toBeGreaterThan(180);
  });

  it('uncanny tier can echo a word from an older question, not the latest', () => {
    const rng = seededRng(9);
    const engine = new CorrelationEngine(
      cfg((c) => {
        c.spiritBox.correlation.weights = { unrelated: 0, loose: 0, relevant: 0, uncanny: 1 };
        c.spiritBox.correlation.delayedEchoChance = 1;
        c.spiritBox.response.audioEventChance = 0;
      }),
      rng,
    );
    const memory = new QuestionMemory();
    memory.add({ id: 'old', at: 0, analysis: analyze('Were you in the cellar?') });
    memory.add({ id: 'new', at: 40, analysis: analyze('Are you angry?') });
    const p = engine.plan(45, memory);
    expect(p.type).toBe('voice');
    if (p.type === 'voice') {
      expect(p.sourceUtterance).toBe('old');
      expect(p.entry.text).toBe('cellar');
    }
  });

  it('falls back to unrelated when nothing has been asked', () => {
    const engine = new CorrelationEngine(cfg(), seededRng(1));
    const memory = new QuestionMemory();
    for (let i = 0; i < 200; i++) expect(engine.plan(i, memory).tier).toBe('unrelated');
  });
});

describe('interpretation', () => {
  it('hedges unclear fragments and withholds readings for unintelligible ones', () => {
    const rng = seededRng(2);
    const engine = new CorrelationEngine(cfg(), rng);
    const memory = new QuestionMemory();
    let withReading = 0;
    let without = 0;
    for (let i = 0; i < 2000; i++) {
      const p = engine.plan(i * 10, memory);
      if (p.type === 'voice') engine.markPlayed(p.entry.id, i * 10);
      const it = interpret(p, 0.4, DEFAULT_CONFIG, rng);
      if (it.reading) withReading++;
      else without++;
      if (p.type === 'voice' && (p.form === 'unintelligible' || p.form === 'syllable')) expect(it.reading).toBeUndefined();
    }
    expect(without).toBeGreaterThan(300);
    expect(withReading).toBeGreaterThan(800);
  });
});

describe('response scheduler', () => {
  function run(seed: number, opts: { questions: number; silenceAfter?: number }) {
    const rng = seededRng(seed);
    const config = cfg();
    const memory = new QuestionMemory();
    const engine = new CorrelationEngine(config, rng);
    const fired: { at: number; cause: string }[] = [];
    const decisions: Decision[] = [];
    const s = new ResponseScheduler(config, engine, memory, rng, {
      fire: (_p, cause, at) => {
        fired.push({ at, cause });
        return 0.5;
      },
      decided: (d) => decisions.push(d),
    });
    let t = 0;
    const askedAt: number[] = [];
    for (let q = 0; q < opts.questions; q++) {
      s.onSpeechStart(t);
      for (let k = 0; k < 20; k++) s.tick((t += 0.1));
      askedAt.push(t);
      s.onUtterance(t, { id: `q${q}`, at: t, analysis: analyze('Is anyone here with us?') });
      for (let k = 0; k < 450; k++) s.tick((t += 0.1)); // 45 s between questions
    }
    for (let k = 0; k < (opts.silenceAfter ?? 0) * 10; k++) s.tick((t += 0.1));
    return { fired, decisions, askedAt, end: t };
  }

  it('leaves a large share of questions unanswered', () => {
    const { decisions } = run(4, { questions: 400 });
    const silent = decisions.filter((d) => d.kind === 'silence').length / decisions.length;
    expect(silent).toBeGreaterThan(0.3);
    expect(silent).toBeLessThan(0.65);
  });

  it('spreads response delays from ~1 s to tens of seconds', () => {
    const { decisions } = run(8, { questions: 400 });
    const delays = decisions.flatMap((d) => (d.kind === 'scheduled' ? [d.delay] : []));
    expect(Math.min(...delays)).toBeLessThan(1.5);
    expect(Math.max(...delays)).toBeGreaterThan(18);
    const quick = delays.filter((d) => d <= 3).length / delays.length;
    expect(quick).toBeGreaterThan(0.15);
    expect(quick).toBeLessThan(0.4);
  });

  it('respects the minimum gap except for bursts', () => {
    const { fired } = run(12, { questions: 300 });
    for (let i = 1; i < fired.length; i++) {
      if (fired[i].cause === 'burst') continue;
      expect(fired[i].at - fired[i - 1].at).toBeGreaterThanOrEqual(DEFAULT_CONFIG.spiritBox.response.minGapSec);
    }
  });

  it('produces occasional spontaneous fragments during long silence', () => {
    const { fired, askedAt } = run(21, { questions: 1, silenceAfter: 3600 });
    const spontaneous = fired.filter((f) => f.cause === 'spontaneous' && f.at > askedAt[0] + 60);
    // ~0.22/min over ~60 min ≈ 13; allow wide variance but require "rare, not never"
    expect(spontaneous.length).toBeGreaterThan(4);
    expect(spontaneous.length).toBeLessThan(30);
  });
});
