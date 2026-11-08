/**
 * Question analysis: turns an investigator's transcribed utterance into weighted concepts.
 *
 * The concept ids here are the same tags used in vocabulary.json, so the correlation engine
 * can find fragments that relate to what was asked. Analysis is deliberately shallow (lexicon
 * + light stemming): it only needs to know roughly what an utterance is "about".
 */

export type Concept =
  | 'presence' | 'identity' | 'male' | 'female' | 'child' | 'age' | 'death' | 'harm' | 'place'
  | 'below' | 'above' | 'passage' | 'leave' | 'stay' | 'want' | 'help' | 'sign' | 'time' | 'number'
  | 'anger' | 'fear' | 'sorrow' | 'family' | 'cold' | 'sight' | 'sound' | 'investigator' | 'faith'
  | 'water' | 'fire' | 'dark' | 'animal' | 'work' | 'rest' | 'affirm' | 'negate' | 'location'
  | 'body' | 'night' | 'home' | 'object' | 'travel' | 'name';

/** What sort of answer a question invites; used only by the rare "relevant"/"uncanny" tiers. */
export type AnswerKind = 'yesno' | 'who' | 'where' | 'when' | 'what' | 'why' | 'howmany' | 'open';

export interface Analysis {
  text: string;
  isQuestion: boolean;
  answer: AnswerKind;
  /** concept -> salience (0..1+) */
  concepts: Map<Concept, number>;
  /** significant words as spoken (lower-case), used for delayed echoes */
  keywords: string[];
}

const LEXICON: Record<string, Concept[]> = {
  // presence
  anyone: ['presence'], anybody: ['presence'], someone: ['presence'], somebody: ['presence'], here: ['presence', 'place'],
  present: ['presence'], spirit: ['presence', 'death'], ghost: ['presence', 'death'], entity: ['presence'], soul: ['presence', 'faith'],
  presence: ['presence'], exist: ['presence'], else: ['presence'], with: ['presence'], alone: ['presence', 'sorrow'],
  // identity
  who: ['identity'], name: ['identity', 'name'], called: ['identity', 'name'], call: ['name', 'sound'], identify: ['identity'],
  // gender / people
  man: ['male'], men: ['male'], male: ['male'], boy: ['male', 'child'], guy: ['male'], gentleman: ['male'], he: ['male'], him: ['male'],
  woman: ['female'], women: ['female'], female: ['female'], girl: ['female', 'child'], lady: ['female'], she: ['female'], her: ['female'],
  child: ['child'], children: ['child'], kid: ['child'], kids: ['child'], baby: ['child', 'family'], little: ['child'], young: ['child', 'age'],
  mother: ['family', 'female'], mom: ['family', 'female'], mum: ['family', 'female'], mama: ['family', 'female'],
  father: ['family', 'male'], dad: ['family', 'male'], daddy: ['family', 'male'], papa: ['family', 'male'],
  sister: ['family', 'female'], brother: ['family', 'male'], wife: ['family', 'female'], husband: ['family', 'male'],
  son: ['family', 'male', 'child'], daughter: ['family', 'female', 'child'], family: ['family'], parent: ['family'],
  grandmother: ['family', 'female', 'age'], grandma: ['family', 'female', 'age'], grandfather: ['family', 'male', 'age'], grandpa: ['family', 'male', 'age'],
  friend: ['identity', 'presence'], people: ['presence'], person: ['presence'],
  // age / number / time
  old: ['age'], age: ['age'], born: ['age', 'time'], year: ['time', 'age'], birthday: ['age', 'time'],
  many: ['number'], number: ['number'], count: ['number'], much: ['number'],
  when: ['time'], time: ['time'], long: ['time'], ago: ['time'], date: ['time'], day: ['time'], today: ['time'], now: ['time'],
  tonight: ['night', 'time'], night: ['night', 'dark'], morning: ['time'], late: ['time'], soon: ['time'], before: ['time'],
  // death / harm
  die: ['death'], died: ['death'], dead: ['death'], death: ['death'], dying: ['death'], kill: ['death', 'harm'],
  killed: ['death', 'harm'], murder: ['death', 'harm'], pass: ['death'], passed: ['death'], buried: ['death', 'below'],
  bury: ['death', 'below'], grave: ['death'], funeral: ['death', 'faith'], body: ['body', 'death'], hang: ['death', 'harm'],
  hurt: ['harm'], pain: ['harm'], injure: ['harm'], injured: ['harm'], sick: ['harm'], ill: ['harm'], illness: ['harm'],
  disease: ['harm'], blood: ['harm', 'body'], accident: ['harm', 'death'], suffer: ['harm'], drown: ['water', 'death'],
  // places
  house: ['place', 'home'], home: ['home', 'place'], room: ['place'], building: ['place'], place: ['place'], live: ['place', 'home'],
  basement: ['below', 'place'], cellar: ['below', 'place'], downstairs: ['below', 'place'], down: ['below'], under: ['below'],
  below: ['below'], ground: ['below'], upstairs: ['above', 'place'], attic: ['above', 'place'], up: ['above'], above: ['above'],
  roof: ['above'], ceiling: ['above'], floor: ['place', 'below'], kitchen: ['place', 'home'], bedroom: ['place', 'rest'],
  door: ['passage'], doorway: ['passage'], window: ['passage', 'sight'], hall: ['passage', 'place'], hallway: ['passage', 'place'],
  stair: ['passage'], stairs: ['passage'], staircase: ['passage'], corner: ['location'], wall: ['place'], closet: ['place', 'dark'],
  outside: ['leave', 'location'], inside: ['location'], where: ['location'], behind: ['location'], there: ['location', 'presence'],
  // movement
  leave: ['leave'], go: ['leave'], gone: ['leave'], out: ['leave'], away: ['leave'], exit: ['leave'], depart: ['leave'], move: ['sign'],
  come: ['presence'], follow: ['presence', 'travel'], walk: ['travel'], run: ['leave', 'fear'], open: ['passage', 'sign'],
  close: ['passage'], shut: ['passage'], lock: ['passage'], locked: ['passage', 'stay'], stuck: ['stay'], trap: ['stay'], trapped: ['stay'],
  stay: ['stay'], remain: ['stay'], forever: ['stay', 'time'], still: ['stay'], wait: ['stay'], keep: ['stay'],
  // desire / help
  want: ['want'], need: ['want'], wish: ['want'], why: ['want'], looking: ['want', 'sight'], find: ['want'], search: ['want'],
  lost: ['want', 'sorrow'], help: ['help'], save: ['help'], rescue: ['help'], free: ['help', 'leave'], peace: ['rest'],
  rest: ['rest'], sleep: ['rest'], tired: ['rest'],
  // signs / communication
  sign: ['sign'], knock: ['sign', 'sound'], tap: ['sign', 'sound'], touch: ['sign', 'body'], show: ['sign', 'sight'],
  prove: ['sign'], make: ['sign'], noise: ['sign', 'sound'], sound: ['sound'], light: ['sight', 'dark'], flash: ['sign', 'sight'],
  hear: ['sound'], listen: ['sound'], talk: ['sound'], speak: ['sound'], say: ['sound'], tell: ['sound'], voice: ['sound'],
  word: ['sound'], answer: ['sound', 'sign'], communicate: ['sound'], understand: ['sound'], respond: ['sound', 'sign'],
  see: ['sight'], look: ['sight'], watch: ['sight'], watching: ['sight'], eye: ['sight', 'body'], appear: ['sight', 'sign'],
  dark: ['dark'], darkness: ['dark'], shadow: ['dark', 'sight'], black: ['dark'],
  // feelings
  angry: ['anger'], mad: ['anger'], upset: ['anger', 'sorrow'], hate: ['anger'], afraid: ['fear'], scared: ['fear'],
  fear: ['fear'], frightened: ['fear'], sad: ['sorrow'], sorry: ['sorrow'], lonely: ['sorrow', 'presence'], miss: ['sorrow', 'want'],
  cry: ['sorrow'], love: ['family'], happy: ['affirm'], hello: ['presence'],
  // the investigator
  me: ['investigator'], my: ['investigator'], us: ['investigator'], we: ['investigator'], our: ['investigator'], i: ['investigator'],
  // faith
  god: ['faith'], pray: ['faith'], prayer: ['faith'], church: ['faith', 'place'], heaven: ['faith', 'death'], hell: ['faith', 'anger'],
  devil: ['faith', 'anger'], demon: ['faith', 'anger'], angel: ['faith'], jesus: ['faith'], bless: ['faith'],
  // elements & senses
  cold: ['cold'], colder: ['cold'], warm: ['cold', 'fire'], hot: ['fire'], temperature: ['cold'], freezing: ['cold'], chill: ['cold'],
  water: ['water'], river: ['water'], lake: ['water'], rain: ['water'], fire: ['fire', 'harm'], burn: ['fire', 'harm'],
  burned: ['fire', 'harm'], smoke: ['fire'],
  // misc
  dog: ['animal'], cat: ['animal'], animal: ['animal'], horse: ['animal'], work: ['work'], job: ['work'], farm: ['work'],
  thing: ['object'], object: ['object'], hat: ['object', 'male'], key: ['object', 'passage'], car: ['travel'], hand: ['body', 'sign'],
};

const STOPWORDS = new Set(
  'a an the is are was were be been being am do does did done to of in on at for from by and or but if so as it its this that these those you your yours yourself what which can could would should will shall may might must have has had there their them they he she his hers just like um uh okay ok please any some all very really right yeah yes no not'.split(
    ' ',
  ),
);

const AUX_START = /^(is|are|was|were|do|does|did|can|could|would|will|have|has|had|should|shall|may|am|ain't|isn't|aren't|don't|didn't|won't|can't)\b/;

/** Very small suffix stripper, enough to fold common inflections onto lexicon entries. */
export function stem(word: string): string {
  if (LEXICON[word]) return word;
  const rules: [RegExp, string][] = [
    [/ies$/, 'y'], [/ied$/, 'y'], [/ing$/, ''], [/ed$/, ''], [/es$/, ''], [/s$/, ''], [/ly$/, ''], [/er$/, ''],
  ];
  for (const [re, rep] of rules) {
    if (!re.test(word)) continue;
    const base = word.replace(re, rep);
    if (LEXICON[base]) return base;
    if (LEXICON[base + 'e']) return base + 'e';
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2] && LEXICON[base.slice(0, -1)]) return base.slice(0, -1);
  }
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function analyze(text: string): Analysis {
  const tokens = tokenize(text);
  const joined = tokens.join(' ');
  const concepts = new Map<Concept, number>();
  const add = (c: Concept, w: number) => concepts.set(c, (concepts.get(c) ?? 0) + w);

  let answer: AnswerKind = 'open';
  if (/\bhow (many|much|old)\b/.test(joined)) answer = 'howmany';
  else if (/^(what('s| is) your name|who\b)/.test(joined) || /\bwho (are|is|was)\b/.test(joined) || /\byour name\b/.test(joined)) answer = 'who';
  else if (/\bwhere\b/.test(joined)) answer = 'where';
  else if (/\bwhen\b|\bwhat year\b/.test(joined)) answer = 'when';
  else if (/\bwhy\b/.test(joined)) answer = 'why';
  else if (/^what\b|\bwhat (do|did|is|are)\b/.test(joined)) answer = 'what';
  else if (AUX_START.test(joined) || /\b(is|are) (there|anyone|anybody|someone|you)\b/.test(joined)) answer = 'yesno';

  const isQuestion =
    /\?\s*$/.test(text) || answer !== 'open' || /^(tell me|give me|can you|could you|show me|knock|say)\b/.test(joined);

  const keywords: string[] = [];
  tokens.forEach((tok, i) => {
    const base = stem(tok.replace(/'s$/, ''));
    const hits = LEXICON[base];
    // Later words in a question tend to carry its topic ("did you die HERE").
    const position = 0.75 + 0.5 * (i / Math.max(1, tokens.length - 1));
    if (hits) hits.forEach((c, j) => add(c, (j === 0 ? 1 : 0.6) * position));
    if (!STOPWORDS.has(tok) && tok.length > 2) keywords.push(tok);
  });

  // Phrase-level cues the lexicon misses.
  if (/\bpass(ed)? (away|on)\b/.test(joined)) add('death', 1.2);
  if (/\bhow old\b/.test(joined)) add('age', 1.3);
  if (/\b(give|make|show) (me|us) a sign\b/.test(joined)) add('sign', 1.2);
  if (/\bwith us\b|\bin here\b|\bin this room\b/.test(joined)) add('presence', 0.8);
  if (answer === 'who') add('identity', 0.8);
  if (answer === 'where') add('location', 0.8);
  if (answer === 'when') add('time', 0.6);
  if (answer === 'howmany') add('number', 0.8);
  if (/\byou\b/.test(joined)) add('identity', 0.25);

  // Normalise so the strongest concept is 1.
  let max = 0;
  for (const v of concepts.values()) max = Math.max(max, v);
  if (max > 0) for (const [k, v] of concepts) concepts.set(k, v / max);

  return { text, isQuestion, answer, concepts, keywords };
}

/**
 * Which concepts sit "next to" each other. Loose associations are drawn from here, which
 * is what lets "did you die here?" drift toward "cold", "stairs" or "rest" rather than "dead".
 */
export const ADJACENT: Partial<Record<Concept, Concept[]>> = {
  presence: ['stay', 'place', 'sound', 'sight', 'identity', 'investigator'],
  identity: ['name', 'family', 'presence', 'male', 'female'],
  male: ['family', 'age', 'work', 'identity'],
  female: ['family', 'child', 'identity'],
  child: ['family', 'sound', 'fear', 'rest'],
  age: ['time', 'number', 'family'],
  death: ['rest', 'cold', 'below', 'harm', 'faith', 'stay', 'dark'],
  harm: ['death', 'body', 'fear', 'help'],
  place: ['home', 'below', 'above', 'passage', 'location'],
  below: ['dark', 'cold', 'place', 'death'],
  above: ['place', 'sound', 'passage'],
  passage: ['place', 'leave', 'location', 'dark'],
  leave: ['passage', 'home', 'stay', 'travel'],
  stay: ['presence', 'leave', 'time', 'rest'],
  want: ['help', 'home', 'object', 'family', 'leave'],
  help: ['want', 'harm', 'fear'],
  sign: ['sound', 'sight', 'presence', 'passage'],
  time: ['age', 'number', 'night', 'stay'],
  number: ['age', 'time'],
  anger: ['leave', 'negate', 'fear'],
  fear: ['dark', 'harm', 'leave', 'help'],
  sorrow: ['family', 'want', 'presence'],
  family: ['home', 'child', 'identity'],
  cold: ['death', 'water', 'night', 'dark'],
  sight: ['dark', 'presence', 'body'],
  sound: ['presence', 'sign', 'body'],
  investigator: ['presence', 'identity', 'sight'],
  faith: ['death', 'rest', 'sound'],
  water: ['cold', 'death', 'place'],
  fire: ['harm', 'death', 'dark'],
  dark: ['night', 'below', 'fear', 'sight'],
  home: ['family', 'place', 'leave'],
  location: ['place', 'passage', 'below', 'above'],
  name: ['identity', 'family'],
  rest: ['death', 'night', 'stay'],
};
