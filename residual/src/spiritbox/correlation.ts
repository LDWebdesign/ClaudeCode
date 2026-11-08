/**
 * Correlation engine: decides what a spirit-box fragment is, and how (or whether) it relates
 * to anything the investigator has said.
 *
 * The relationship is drawn from a weighted tier table (default 65/25/9/1):
 *   unrelated - drawn from the whole vocabulary, avoiding the active topic; mostly broadcast bleed
 *   loose     - shares an adjacent concept ("did you die here?" -> "cold", "stairs", "rest")
 *   relevant  - shares the topic itself ("did you die here?" -> "gone", "buried")
 *   uncanny   - a delayed echo of an earlier question's own word, or a pointed answer
 *
 * The target concept is sampled from decaying memory, not taken from the latest question, so
 * relevance is often displaced in time. A hidden per-session "persona" keeps the rare pointed
 * answers (a name, a number, a place) consistent across a session.
 */
import type { ResidualConfig } from '../config';
import { type Rng, chance, clamp, gaussian, pick, pickBy, pickWeighted } from '../util/rng';
import { ADJACENT, type AnswerKind, type Concept } from './concepts';
import type { ActiveConcept, QuestionMemory, Utterance } from './memory';
import { BY_TEXT, VOCAB, type VocabEntry, entry } from './vocabulary';

export type Tier = 'unrelated' | 'loose' | 'relevant' | 'uncanny';
export type Form = 'word' | 'partial' | 'syllable' | 'pseudo' | 'unintelligible';
export type AudioEventKind = 'knock' | 'breath' | 'carrier' | 'tone';

export interface VoicePlan {
  type: 'voice';
  tier: Tier;
  entry: VocabEntry;
  /** second source for spliced pseudo-words */
  splice?: VocabEntry;
  form: Form;
  /** for partial forms: keep the start (true) or the end (false) */
  keepStart: boolean;
  /** 0..1 intended intelligibility; the audio chain degrades accordingly */
  clarity: number;
  concept?: Concept;
  sourceUtterance?: string;
  reason: string;
}

export interface EventPlan {
  type: 'event';
  tier: Tier;
  event: AudioEventKind;
  concept?: Concept;
  sourceUtterance?: string;
  reason: string;
}

export type FragmentPlan = VoicePlan | EventPlan;

export interface Persona {
  name: VocabEntry;
  number: VocabEntry;
  place: VocabEntry;
  cause: VocabEntry;
}

const CHARGE_UNRELATED = [1, 0.75, 0.32, 0.1];
const CHARGE_RELATED = [0.55, 0.85, 1, 0.8];
const FORM_CLARITY: Record<Form, number> = { word: 0.78, partial: 0.55, syllable: 0.22, pseudo: 0.42, unintelligible: 0.08 };

const POINTED: Partial<Record<Concept, string[]>> = {
  presence: ['still here', 'with you', 'right here', 'always', 'waiting', 'listening'],
  death: ['the stairs', 'the cellar', 'the water', 'buried', 'too late', 'gone', 'fell'],
  leave: ['not yet', "don't go", "can't", 'locked', 'stay'],
  stay: ['always', 'locked', 'waiting', 'not yet'],
  want: ['home', 'find her', 'find him', 'let me', 'mine'],
  help: ['help me', 'too late', 'please'],
  investigator: ['you', 'not you', 'watching', 'with you'],
  location: ['downstairs', 'behind', 'under the', 'upstairs', 'the cellar', 'in the walls'],
  below: ['downstairs', 'under the', 'the cellar', 'buried'],
  above: ['upstairs', 'attic', 'come up'],
  cold: ['so cold', 'winter', 'freezing'],
  family: ['my mother', 'mama', 'sister', 'father'],
  child: ['mama', 'doll', 'hiding'],
  fear: ['hide', 'quiet', "don't tell"],
  harm: ['hurts', "can't breathe", 'fell', 'fever'],
  sound: ['listen', 'I know', 'whisper'],
  sight: ['watching', "can't see", 'mirror'],
  time: ['long time', 'years ago', 'not yet'],
  rest: ['sleep', 'quiet', 'no more'],
};

const NAMES = VOCAB.filter((e) => e.kind === 'name');
const AGES = VOCAB.filter((e) => e.kind === 'number' && e.tags.includes('age'));
const PLACES = ['cellar', 'stairs', 'attic', 'well', 'river', 'barn', 'closet', 'basement', 'landing'].map((w) => BY_TEXT.get(w)!);
const CAUSES = ['fever', 'fell', 'water', 'fire', 'cold', 'sick', 'accident'].map((w) => BY_TEXT.get(w)!);

export function createPersona(rng: Rng): Persona {
  return { name: pick(rng, NAMES), number: pick(rng, AGES), place: pick(rng, PLACES), cause: pick(rng, CAUSES) };
}

export class CorrelationEngine {
  private history: { id: number; at: number }[] = [];
  private clock = 0;
  persona: Persona;

  constructor(
    private readonly config: () => ResidualConfig,
    private readonly rng: Rng,
  ) {
    this.persona = createPersona(rng);
  }

  resetSession(): void {
    this.history = [];
    this.persona = createPersona(this.rng);
  }

  /** Records that an entry was actually played, for repetition control. */
  markPlayed(id: number, at: number): void {
    this.history.unshift({ id, at });
    if (this.history.length > 400) this.history.length = 400;
  }

  plan(now: number, memory: QuestionMemory, opts: { spontaneous?: boolean } = {}): FragmentPlan {
    this.clock = now;
    const cfg = this.config().spiritBox;
    const active = memory.active(now, cfg.correlation.memoryHalfLifeSec, cfg.correlation.recencyBias);
    const totalWeight = active.reduce((s, a) => s + a.weight, 0);

    let tier: Tier = pickWeighted(this.rng, cfg.correlation.weights) ?? 'unrelated';
    // With nothing meaningful in memory there is nothing to relate to.
    if (totalWeight < 0.05) tier = 'unrelated';
    // Spontaneous fragments lean further toward noise.
    if (opts.spontaneous && tier === 'loose' && chance(this.rng, 0.4)) tier = 'unrelated';

    const target = tier === 'unrelated' ? undefined : pickBy(this.rng, active, (a) => a.weight);

    if (chance(this.rng, cfg.response.audioEventChance)) {
      return this.eventPlan(tier, target);
    }
    if (target?.concept === 'sign' && (tier === 'relevant' || tier === 'uncanny') && chance(this.rng, 0.5)) {
      return { type: 'event', tier, event: 'knock', concept: 'sign', sourceUtterance: target.utterance.id, reason: 'asked for a sign' };
    }

    switch (tier) {
      case 'uncanny':
        return this.uncanny(now, memory, target!) ?? this.related('relevant', target!, active, 'uncanny-fallback');
      case 'relevant':
      case 'loose':
        return this.related(tier, target!, active, tier);
      default:
        return this.unrelated(active);
    }
  }

  // --- tiers ----------------------------------------------------------------------------

  private unrelated(active: ActiveConcept[]): VoicePlan {
    const avoid = new Set<Concept>();
    for (const a of active) {
      if (a.weight < 0.08) continue;
      avoid.add(a.concept);
      for (const adj of ADJACENT[a.concept] ?? []) avoid.add(adj);
    }
    const bleed = this.config().spiritBox.audio.radioBleed;
    const choice =
      this.choose((e) => {
        if (e.tags.some((t) => avoid.has(t))) return 0;
        let w = e.freq * CHARGE_UNRELATED[e.charge];
        if (e.kind === 'radio') w *= 0.7 + bleed;
        if (e.kind === 'name') w *= 0.25;
        if (e.kind === 'number') w *= 0.5;
        if (e.kind === 'phrase') w *= 0.5;
        return w;
      }) ?? this.choose((e) => e.freq * CHARGE_UNRELATED[e.charge])!;
    return this.voice('unrelated', choice, undefined, 'unrelated draw');
  }

  private related(tier: 'loose' | 'relevant', target: ActiveConcept, active: ActiveConcept[], reason: string): VoicePlan {
    const answer = target.utterance.analysis.answer;
    const concept = target.concept;
    let pool: (e: VocabEntry) => number;

    if (tier === 'relevant') {
      pool = (e) => {
        const idx = e.tags.indexOf(concept);
        if (idx < 0) return 0;
        let w = e.freq * CHARGE_RELATED[e.charge] * (idx === 0 ? 1 : 0.7);
        w *= answerFit(answer, e);
        if (this.isPersona(e)) w *= 4;
        if (e.kind === 'radio' || e.kind === 'filler') w = 0;
        return w;
      };
    } else {
      const near = new Set<Concept>(ADJACENT[concept] ?? []);
      // secondary concepts from the same utterance also count as loose associations
      for (const a of active) if (a.utterance === target.utterance && a.concept !== concept) near.add(a.concept);
      pool = (e) => {
        if (e.tags.includes(concept)) return 0;
        const hits = e.tags.filter((t) => near.has(t)).length;
        if (!hits) return 0;
        return e.freq * CHARGE_RELATED[e.charge] * (hits > 1 ? 1.3 : 1);
      };
    }
    const choice = this.choose(pool);
    if (!choice) return this.unrelated(active);
    return this.voice(tier, choice, target, reason);
  }

  private uncanny(now: number, memory: QuestionMemory, target: ActiveConcept): FragmentPlan | undefined {
    const cfg = this.config().spiritBox.correlation;

    if (chance(this.rng, cfg.delayedEchoChance)) {
      const older = memory.all.filter((u) => now - u.at >= cfg.delayedEchoMinAgeSec);
      const candidates: { e: VocabEntry; u: Utterance }[] = [];
      for (const u of older) {
        for (const k of u.analysis.keywords) {
          const e = entry(k);
          if (e && e.kind !== 'radio' && e.kind !== 'filler' && this.cooldownWeight(e, now) > 0) candidates.push({ e, u });
        }
      }
      const echo = candidates.length ? pick(this.rng, candidates) : undefined;
      if (echo) {
        return {
          ...this.voice('uncanny', echo.e, undefined, `delayed echo of "${echo.u.analysis.text}"`),
          concept: target.concept,
          sourceUtterance: echo.u.id,
          form: 'word',
          clarity: clamp(0.7 + gaussian(this.rng) * 0.08, 0.5, 0.92),
        };
      }
    }

    const answer = target.utterance.analysis.answer;
    let words: string[] | undefined;
    if (answer === 'who' || target.concept === 'name') words = [this.persona.name.text];
    else if (answer === 'howmany' || target.concept === 'age' || target.concept === 'number') words = [this.persona.number.text];
    else if (answer === 'where') words = [this.persona.place.text, ...(POINTED.location ?? [])];
    else if (target.concept === 'death' || target.concept === 'harm') words = [this.persona.cause.text, this.persona.place.text, ...(POINTED.death ?? [])];
    else words = POINTED[target.concept];
    if (!words) return undefined;

    const options = words.map((w) => entry(w)).filter((e): e is VocabEntry => !!e && this.cooldownWeight(e, now) > 0);
    if (!options.length) return undefined;
    const choice = options[0] && this.isPersona(options[0]) && chance(this.rng, 0.6) ? options[0] : pick(this.rng, options);
    const plan = this.voice('uncanny', choice, target, `pointed answer (${answer}/${target.concept})`);
    plan.form = chance(this.rng, 0.85) ? 'word' : 'partial';
    plan.clarity = clamp(Math.max(plan.clarity, 0.62) + gaussian(this.rng) * 0.06, 0.45, 0.92);
    return plan;
  }

  private eventPlan(tier: Tier, target?: ActiveConcept): EventPlan {
    const event = pickWeighted<AudioEventKind>(this.rng, { carrier: 4, tone: 2, breath: 2, knock: 1.2 })!;
    return { type: 'event', tier, event, concept: target?.concept, sourceUtterance: target?.utterance.id, reason: 'audio event' };
  }

  // --- helpers --------------------------------------------------------------------------

  private voice(tier: Tier, e: VocabEntry, target: ActiveConcept | undefined, reason: string): VoicePlan {
    const cfg = this.config().spiritBox;
    const forms = { ...cfg.forms };
    if (tier === 'relevant') {
      forms.word *= 1.6;
      forms.pseudo *= 0.3;
      forms.unintelligible *= 0.3;
      forms.syllable *= 0.5;
    } else if (tier === 'loose') {
      forms.word *= 1.15;
    }
    if (e.kind === 'phrase' && tier !== 'unrelated') forms.syllable *= 0.3;
    const form = pickWeighted<Form>(this.rng, forms) ?? 'word';
    const splice = form === 'pseudo' ? this.choose((x) => (x.id !== e.id && x.kind !== 'phrase' ? x.freq : 0)) : undefined;

    const clarityKnob = 0.55 + 0.9 * cfg.audio.clarity;
    let clarity = FORM_CLARITY[form] * clarityKnob + gaussian(this.rng) * 0.12;
    if (tier === 'relevant') clarity += 0.06;
    return {
      type: 'voice',
      tier,
      entry: e,
      splice,
      form,
      keepStart: chance(this.rng, 0.6),
      clarity: clamp(clarity, 0.02, 0.95),
      concept: target?.concept,
      sourceUtterance: target?.utterance.id,
      reason,
    };
  }

  private choose(weight: (e: VocabEntry) => number): VocabEntry | undefined {
    return pickBy(this.rng, VOCAB, (e) => {
      const w = weight(e);
      return w > 0 ? w * this.cooldownWeight(e, this.clock) : 0;
    });
  }

  private cooldownWeight(e: VocabEntry, now: number): number {
    const { cooldownFragments, cooldownSec } = this.config().spiritBox.repetition;
    const scale = this.isPersona(e) ? 0.35 : 1;
    const idx = this.history.findIndex((h) => h.id === e.id);
    if (idx < 0) return 1;
    if (idx < cooldownFragments * scale) return 0;
    const age = now - this.history[idx].at;
    if (age < cooldownSec * scale) return 0.05;
    return 1;
  }

  private isPersona(e: VocabEntry): boolean {
    const p = this.persona;
    return e === p.name || e === p.number || e === p.place || e === p.cause;
  }
}

function answerFit(answer: AnswerKind, e: VocabEntry): number {
  switch (answer) {
    case 'who':
      return e.kind === 'name' ? 3 : e.tags.includes('identity') || e.tags.includes('family') ? 1.4 : 1;
    case 'howmany':
      return e.kind === 'number' ? 3 : 1;
    case 'where':
      return e.tags.some((t) => t === 'place' || t === 'below' || t === 'above' || t === 'location' || t === 'passage') ? 2 : 1;
    case 'when':
      return e.tags.includes('time') || e.kind === 'number' ? 2 : 1;
    case 'yesno':
      return e.tags.includes('affirm') || e.tags.includes('negate') ? 1.4 : 1;
    case 'why':
      return e.tags.includes('want') || e.tags.includes('harm') ? 1.5 : 1;
    default:
      return 1;
  }
}
