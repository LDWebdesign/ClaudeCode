import type { Analysis, Concept } from './concepts';

export interface Utterance {
  id: string;
  /** seconds on the session clock when the investigator finished speaking */
  at: number;
  analysis: Analysis;
}

export interface ActiveConcept {
  concept: Concept;
  weight: number;
  utterance: Utterance;
}

/**
 * Remembers what the investigator has said, with influence decaying over time. Responses
 * are chosen from this memory when they fire, not when they are scheduled, which is what
 * lets a fragment relate to something asked half a minute earlier rather than to the
 * question just asked.
 */
export class QuestionMemory {
  private items: Utterance[] = [];

  constructor(private readonly limit = 16) {}

  add(u: Utterance): void {
    this.items.unshift(u);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  get all(): readonly Utterance[] {
    return this.items;
  }

  latest(): Utterance | undefined {
    return this.items[0];
  }

  active(now: number, halfLifeSec: number, recencyBias: number): ActiveConcept[] {
    const out: ActiveConcept[] = [];
    this.items.forEach((u, i) => {
      const age = Math.max(0, now - u.at);
      const decay = Math.pow(0.5, age / Math.max(1, halfLifeSec));
      const recency = i === 0 ? 1 : 1 - recencyBias;
      const questionBoost = u.analysis.isQuestion ? 1 : 0.6;
      for (const [concept, salience] of u.analysis.concepts) {
        const weight = salience * decay * recency * questionBoost;
        if (weight > 0.02) out.push({ concept, weight, utterance: u });
      }
    });
    return out;
  }

  clear(): void {
    this.items = [];
  }
}
