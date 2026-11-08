/**
 * How a fragment is described in the investigation log. Interpretations are hedged the way a
 * human reviewer would hedge them: clear fragments get a reading, unclear ones get a reading
 * with alternatives, and the least clear get no reading at all.
 */
import type { ResidualConfig } from '../config';
import { type Rng, chance } from '../util/rng';
import type { FragmentPlan, VoicePlan } from './correlation';
import { VOCAB } from './vocabulary';

export type LogKind = 'evp' | 'fragment' | 'signal' | 'event';

export interface Interpretation {
  kind: LogKind;
  /** headline such as "Possible EVP" */
  title: string;
  /** the reading, e.g. "…back…" — absent when nothing intelligible was heard */
  reading?: string;
  alternates: string[];
  detail: string;
  /** false when the fragment should only exist on the recording */
  logged: boolean;
}

/** Common short words that a listener might hear instead of the intended fragment. */
const HEARD_AS = (
  'back bat black bag pack that lack hat had have half hall call fall ball all wall walk talk ' +
  'go no so though home hold old cold told gold row road rode load ' +
  'here hear near ear year fear dear there where wear air hair care ' +
  'down town found sound round now how out house mouse ' +
  'stay say day way may they weigh wait gate late eight ' +
  'stairs stars chairs theirs cellar seller sell fella better letter ' +
  'door more four for floor your poor four store ' +
  'leave live believe sleeve please knees free three tree see ' +
  'help held hell well yelp self ' +
  'gone on john done one won none ' +
  'dead bed red head said fed led ' +
  'cold coat code goal hole whole ' +
  'mother other brother bother ' +
  'behind blind kind find mind wind'
)
  .split(' ')
  .filter(Boolean);

const LEXICON = [...new Set([...HEARD_AS, ...VOCAB.filter((e) => !e.text.includes(' ')).map((e) => e.text.toLowerCase())])];

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Rough "sounds like": shared rhyme or small edit distance. */
export function soundalikes(word: string, rng: Rng, max = 2): string[] {
  const w = word.toLowerCase();
  if (w.includes(' ')) return [];
  const rhyme = w.slice(-Math.min(3, w.length - 1));
  const scored = LEXICON.filter((x) => x !== w && Math.abs(x.length - w.length) <= 2)
    .map((x) => ({ x, d: editDistance(x, w) - (x.endsWith(rhyme) ? 1 : 0) }))
    .filter((s) => s.d <= Math.max(1, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d || rng.next() - 0.5);
  return scored.slice(0, max).map((s) => s.x);
}

/** Cuts a word at a syllable-ish boundary; returns undefined when too little survives to read. */
function partialText(text: string, keepStart: boolean): string | undefined {
  const t = text.toLowerCase();
  if (t.includes(' ')) {
    const words = t.split(' ');
    return keepStart ? `${words[0]}—` : `—${words[words.length - 1]}`;
  }
  const m = keepStart ? /^[^aeiouy]*[aeiouy]+[^aeiouy]{0,2}/.exec(t) : /[^aeiouy]{0,2}[aeiouy]+[^aeiouy]*$/.exec(t);
  const kept = m?.[0] ?? '';
  if (kept.length < 3 || kept.length >= t.length) return undefined;
  return keepStart ? `${kept}—` : `—${kept}`;
}

function pseudoText(a: string, b: string): string {
  const x = a.toLowerCase().replace(/ /g, '');
  const y = b.toLowerCase().replace(/ /g, '');
  return x.slice(0, Math.ceil(x.length / 2)) + y.slice(Math.floor(y.length / 2));
}

/** The real word a spliced, word-like sound most resembles (from our own lexicon only). */
function nearestWord(sound: string): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const w of LEXICON) {
    if (Math.abs(w.length - sound.length) > 2) continue;
    const d = editDistance(w, sound);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return bestD <= Math.max(1, Math.floor(sound.length / 3)) ? best : undefined;
}

export function interpret(plan: FragmentPlan, durationSec: number, config: ResidualConfig, rng: Rng): Interpretation {
  const dur = `${durationSec.toFixed(1)} s`;
  if (plan.type === 'event') {
    const map = {
      knock: ['Possible knock', 'Low-frequency transient, origin unclear'],
      breath: ['Unidentified signal', 'Broadband exhalation-like noise'],
      carrier: ['Unidentified signal', 'Carrier held across sweep steps'],
      tone: ['Unidentified signal', 'Narrow tone burst'],
    } as const;
    const [title, detail] = map[plan.event];
    return { kind: 'event', title, alternates: [], detail: `${detail} · ${dur}`, logged: plan.event === 'knock' || chance(rng, 0.6) };
  }

  const v = plan as VoicePlan;
  const cfg = config.spiritBox.log;
  const clarity = v.clarity;
  const text = v.entry.text;

  if (v.form === 'unintelligible' || v.form === 'syllable' || clarity < cfg.interpretClarity * 0.6) {
    return {
      kind: 'signal',
      title: v.form === 'syllable' ? 'Possible audio fragment' : 'Unidentified signal',
      alternates: [],
      detail: `${v.form === 'syllable' ? 'Vocal-band burst' : 'Unintelligible, vocal band'} · ${dur}`,
      logged: !chance(rng, cfg.unloggedLowClarityChance),
    };
  }

  if (v.form === 'pseudo' && v.splice) {
    // A false positive: word-like, but not a word. Report what it resembles, if anything.
    const near = nearestWord(pseudoText(text, v.splice.text));
    return {
      kind: 'fragment',
      title: 'Possible audio fragment',
      reading: near ? `…${near}?` : undefined,
      alternates: [],
      detail: `${near ? 'Uncertain' : 'Word-like, unrecognised'} · ${dur}`,
      logged: !chance(rng, cfg.unloggedLowClarityChance * 0.5),
    };
  }

  const shown = /^[A-Z]/.test(text) ? text : text.toLowerCase();
  const reading = v.form === 'partial' ? partialText(text, v.keepStart) : `…${shown}…`;
  if (!reading) {
    return { kind: 'signal', title: 'Possible audio fragment', alternates: [], detail: `Clipped vocal-band burst · ${dur}`, logged: !chance(rng, cfg.unloggedLowClarityChance) };
  }
  // Obvious broadcast bleed is labelled as such, the way a careful reviewer would.
  if (v.entry.kind === 'radio' && v.form === 'word' && clarity >= 0.5) {
    return { kind: 'fragment', title: 'Possible broadcast fragment', reading, alternates: [], detail: `Likely radio bleed · ${dur}`, logged: true };
  }
  const unclear = clarity < 0.62;
  const alternates = unclear && v.form === 'word' ? soundalikes(text, rng, clarity < 0.5 ? 2 : 1) : [];
  const confidence = clarity >= 0.72 ? 'Clear' : clarity >= 0.55 ? 'Moderate clarity' : 'Low clarity';
  return {
    kind: clarity >= 0.62 && v.form === 'word' ? 'evp' : 'fragment',
    title: clarity >= 0.62 && v.form === 'word' ? 'Possible EVP' : 'Possible audio fragment',
    reading,
    alternates,
    detail: `${confidence} · ${dur}`,
    logged: clarity >= cfg.interpretClarity || !chance(rng, cfg.unloggedLowClarityChance * 0.5),
  };
}

export const describeTier = (plan: FragmentPlan) =>
  `${plan.tier}${plan.concept ? ` · ${plan.concept}` : ''} · ${plan.reason}`;

