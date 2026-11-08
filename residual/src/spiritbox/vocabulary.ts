import raw from './vocabulary.json';
import type { Concept } from './concepts';

export type EntryKind = 'word' | 'phrase' | 'name' | 'number' | 'radio' | 'filler';

export interface VocabEntry {
  /** index into vocabulary.json, also the voice-bank key */
  id: number;
  text: string;
  tags: Concept[];
  /** 0 mundane .. 3 strongly evocative */
  charge: number;
  /** relative base frequency */
  freq: number;
  kind: EntryKind;
}

interface RawEntry {
  w: string;
  t: string[];
  c: number;
  f?: number;
  k?: EntryKind;
}

export const VOCAB: readonly VocabEntry[] = (raw as RawEntry[]).map((e, id) => ({
  id,
  text: e.w,
  tags: e.t as Concept[],
  charge: e.c,
  freq: e.f ?? 1,
  kind: e.k ?? 'word',
}));

export const BY_TEXT = new Map(VOCAB.map((e) => [e.text.toLowerCase(), e]));

export function entry(text: string): VocabEntry | undefined {
  return BY_TEXT.get(text.toLowerCase());
}
