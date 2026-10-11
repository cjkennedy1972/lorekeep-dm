/**
 * Deterministic hard-floor input rules (R-S2, R-S8, ADR-007, ADR-016).
 *
 * Scope: sexual content involving minors. Rules only. No model call, no tier input:
 * the verdict depends on the text alone, so it is identical at every content tier.
 *
 * Policy (ATLAS decision, PR #153 review): bare gendered or family nouns (girl, boy,
 * daughter, son, woman, man, mother) are NOT minor indicators on their own. A minor
 * reference is an explicit youth or age marker: child, kid, minor, underage, teen,
 * preteen, schoolgirl/schoolboy, "young/little girl/boy", toddler, infant, baby, an age
 * under 18 ("15yo", "age 15", "she is 15", "fifteen"), a school-grade term, or a loli/shota
 * term. Tradeoff: ordinary adult RPG prose ("the boy king's brother had sex with the
 * queen's maid") is allowed, at the cost of missing sexual content about a minor that
 * is described only with a bare noun ("the boy was raped"). The LLM judge (M3-07) is the
 * second layer for those ambiguous cases. These rules alone do not satisfy R-S2.
 *
 * Matching: a minor reference and a sexual term are evaluated across the whole message,
 * not per sentence: within WINDOW_TOKENS tokens anywhere, or within CARRY_TOKENS tokens
 * and two sentences when the sexual sentence uses a pronoun ("She is a child. Describe
 * her sexually."). One linear pass over at most MAX_INPUT_CHARS characters.
 *
 * Known limits (see HARD_FLOOR_KNOWN_MISSES): other languages, euphemism and slang beyond
 * the list, references more than CARRY_TOKENS apart, bare-noun minors, images.
 */

export const HARD_FLOOR_VERSION = '2026-10-10.2';

/** Callers cap input far below this (ws text 4000, names 80). Longer input is blocked, never scanned. */
export const MAX_INPUT_CHARS = 20_000;

export const HARD_FLOOR_RULES = {
  'csam.explicit-term': {
    category: 'sexual-content-involving-minors',
    terms: [
      'loli',
      'lolis',
      'lolicon',
      'lolita',
      'lolitas',
      'shota',
      'shotacon',
      'csam',
      'childporn',
      'kiddieporn',
      'kiddyporn',
      'jailbait',
    ],
  },
  'minor-sexual.proximity': {
    category: 'sexual-content-involving-minors',
    /** Explicit youth markers only. Bare girl/boy/daughter/son/woman/man/mother are not here (policy in module header). */
    minorTerms: [
      'child',
      'children',
      'kid',
      'kids',
      'kiddie',
      'kiddies',
      'kiddy',
      'minor',
      'minors',
      'minorage',
      'underage',
      'underaged',
      'teen',
      'teens',
      'teenage',
      'teenaged',
      'teenager',
      'teenagers',
      'tween',
      'tweens',
      'adolescent',
      'adolescents',
      'preteen',
      'preteens',
      'prepubescent',
      'pubescent',
      'toddler',
      'toddlers',
      'infant',
      'infants',
      'baby',
      'babies',
      'juvenile',
      'juveniles',
      'youngster',
      'youngsters',
      'schoolgirl',
      'schoolgirls',
      'schoolboy',
      'schoolboys',
      'schoolchild',
      'schoolchildren',
      'stepchild',
      'stepchildren',
    ],
    /** "young girl", "little boy": the noun counts only right after one of these. */
    youthPrefixes: ['young', 'little'],
    youthNouns: [
      'girl',
      'girls',
      'boy',
      'boys',
      'lad',
      'lads',
      'lass',
      'lasses',
    ],
    sexualTerms: [
      'sexual',
      'sexually',
      'sexualy',
      'sexualize',
      'sexualized',
      'sexualised',
      'sexualizing',
      'sexy',
      'sexier',
      'sexiest',
      'porn',
      'porno',
      'pornographic',
      'pornography',
      'erotic',
      'erotica',
      'nude',
      'nudes',
      'nudity',
      'naked',
      'topless',
      'fondle',
      'fondled',
      'fondling',
      'molest',
      'molested',
      'molesting',
      'molester',
      'molestation',
      'rape',
      'raped',
      'raping',
      'rapes',
      'rapist',
      'orgasm',
      'orgasms',
      'lewd',
      'lewdly',
      'horny',
      'incest',
      'pedophile',
      'pedophiles',
      'paedophile',
      'pedophilia',
      'paedophilia',
      'pedo',
      'sodomize',
      'sodomized',
      'sodomy',
      'masturbate',
      'masturbated',
      'masturbating',
      'masturbation',
      'fellatio',
      'cunnilingus',
      'penis',
      'vagina',
      'vulva',
      'genitals',
      'genital',
      'breast',
      'breasts',
      'nipple',
      'nipples',
    ],
    /** "sex" counts only in these phrases: "have sex", "in sex", "sex with", "sex scene"; "got laid" likewise. */
    sexPhraseNeighbours: {
      before: ['have', 'has', 'had', 'having', 'in'],
      after: [
        'with',
        'scene',
        'scenes',
        'act',
        'acts',
        'slave',
        'slaves',
        'toy',
        'toys',
        'trafficking',
      ],
      /** "has sex appeal", "in sex ed": a following word that cancels the before-neighbour. */
      notAfter: [
        'appeal',
        'symbol',
        'drive',
        'change',
        'ed',
        'education',
        'ratio',
        'chromosome',
        'chromosomes',
        'organ',
        'organs',
      ],
      laidBefore: ['got', 'get', 'gets', 'getting'],
    },
    /** Same sentence: minor and sexual term within this many tokens. */
    windowTokens: 8,
    /** Different sentences (up to two apart): adjacent when this close. */
    adjacentTokens: 4,
    /** Any sentence distance: the sexual sentence uses a pronoun ("She is a child. Ok. Describe her sexually."), or the minor is the subject of the previous sentence. */
    carryTokens: 60,
    /** A minor indicator within this many tokens of its sentence start counts as its subject. */
    subjectTokens: 3,
    /** Messages up to this many characters: any minor indicator and any sexual term block. */
    shortMessageChars: 400,
  },
} as const;

export interface HardFloorResult {
  blocked: boolean;
  rule?: string;
  version: string;
}

const lookalikes = (pairs: Readonly<Record<string, string>>) =>
  Object.entries(pairs).flatMap(([from, to]) => [
    [from, to] as const,
    [from.toLowerCase(), to] as const,
  ]);

const CONFUSABLE = new Map<string, string>([
  // Cyrillic
  ...lookalikes({
    а: 'a',
    е: 'e',
    о: 'o',
    р: 'p',
    с: 'c',
    у: 'y',
    х: 'x',
    і: 'i',
    ј: 'j',
    ѕ: 's',
    һ: 'h',
    ԁ: 'd',
    ԛ: 'q',
    ԝ: 'w',
    ү: 'y',
    ӏ: 'l',
    в: 'b',
    к: 'k',
    м: 'm',
    н: 'h',
    т: 't',
    ԍ: 'g',
    ѵ: 'v',
  }),
  // Greek
  ...lookalikes({
    α: 'a',
    β: 'b',
    ε: 'e',
    ι: 'i',
    κ: 'k',
    ν: 'v',
    ο: 'o',
    ρ: 'p',
    τ: 't',
    υ: 'u',
    χ: 'x',
    γ: 'y',
  }),
  // Cherokee lookalikes (upper and lower case forms)
  ...lookalikes({
    Ꭺ: 'a',
    Ᏼ: 'b',
    Ꮯ: 'c',
    Ꭰ: 'd',
    Ꭼ: 'e',
    Ꮆ: 'g',
    Ꮋ: 'h',
    Ꮖ: 'i',
    Ꭻ: 'j',
    Ꮶ: 'k',
    Ꮮ: 'l',
    Ꮇ: 'm',
    Ꮲ: 'p',
    Ꭱ: 'r',
    Ꮪ: 's',
    Ꭲ: 't',
    Ꮩ: 'v',
    Ꮃ: 'w',
    Ꮓ: 'z',
    Ꭹ: 'y',
  }),
  // Small caps, dotless i, and Latin look-alikes that NFKD leaves alone
  ...Object.entries({
    ᴀ: 'a',
    ʙ: 'b',
    ᴄ: 'c',
    ᴅ: 'd',
    ᴇ: 'e',
    ꜰ: 'f',
    ɢ: 'g',
    ʜ: 'h',
    ɪ: 'i',
    ᴊ: 'j',
    ᴋ: 'k',
    ʟ: 'l',
    ᴍ: 'm',
    ɴ: 'n',
    ᴏ: 'o',
    ᴘ: 'p',
    ʀ: 'r',
    ꜱ: 's',
    ᴛ: 't',
    ᴜ: 'u',
    ᴠ: 'v',
    ᴡ: 'w',
    ʏ: 'y',
    ᴢ: 'z',
    ı: 'i',
    ɩ: 'i',
    ɨ: 'i',
    ɑ: 'a',
    ɡ: 'g',
    ø: 'o',
    đ: 'd',
    ł: 'l',
    ħ: 'h',
    ŧ: 't',
    ƒ: 'f',
    ʋ: 'v',
  }),
]);

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
};
const AGE_NUMBER = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
const WORD_END = '(?![\\p{L}\\p{N}])';
const AGE_PHRASE = new RegExp(
  `\\b${AGE_NUMBER}(?:[\\s-]*(?:yo|y\\/o|y\\.o\\.?|(?:years?|yrs?)[\\s-]*old))${WORD_END}|\\b(?:age|aged)[\\s:]*${AGE_NUMBER}${WORD_END}`,
  'giu',
);
const NO_OLDER_THAN = new RegExp(
  `\\b(?:no|not)[\\s-]+older[\\s-]+than[\\s-]+${AGE_NUMBER}${WORD_END}`,
  'giu',
);
const ONE_COMPOUND = new RegExp(
  `\\bone-(${Object.keys(NUMBER_WORDS).slice(0, 7).join('|')})\\b`,
  'g',
);
/** Euphemisms that imply a minor. "youth" and "tiny" are not here: adults use both words. */
const MINOR_PHRASES: readonly RegExp[] = [
  /\bbarely[\s-]+(?:legal|out[\s-]+of[\s-]+school)\b/g,
  /\bschool[\s-]+uniform\b/g,
  /\byoung[\s-]+looking\b/g,
  /\blittle[\s-]+one\b/g,
];
/** "c.h.i.l.d", "sex.ual": short letter pieces joined by a bare dot are one word. */
const DOT_SPELLING = /(?<!\p{L})(\p{L}{1,3})\.(?=\p{L})/gu;
const UNDER_EIGHTEEN =
  /\b(?:under|below|younger[\s-]+than)[\s-]*(?:the[\s-]+age[\s-]+of[\s-]+)?(?:18|eighteen)\b/g;

const GRADE_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const ORDINAL_WORDS =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth';
/** School-level cues that imply a minor. */
const SCHOOL_CUES: readonly RegExp[] = [
  new RegExp(`\\bgrade[\\s-]*(?:[1-9]|1[0-2]|${GRADE_WORDS})\\b`, 'g'),
  new RegExp(
    `\\b(?:(?:[1-9]|1[0-2])(?:st|nd|rd|th)|${ORDINAL_WORDS})[\\s-]*grad(?:e|er|ers)\\b`,
    'g',
  ),
  /\b(?:middle|elementary|primary|junior[\s-]*high|high|pre|nursery|grade)[\s-]*school(?:er|ers|s)?\b/g,
  /\b(?:kindergarten|kindergartner|kindergartners)\b/g,
];

/** Words after a bare number that make it a quantity, not an age. */
const QUANTITY_UNITS = new Set([
  'minute',
  'minutes',
  'min',
  'mins',
  'hour',
  'hours',
  'day',
  'days',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'feet',
  'foot',
  'ft',
  'mile',
  'miles',
  'yard',
  'yards',
  'paces',
  'steps',
  'inches',
  'gold',
  'gp',
  'sp',
  'cp',
  'coins',
  'silver',
  'copper',
  'hp',
  'damage',
  'percent',
  'times',
  'points',
  'rounds',
  'turns',
  'lbs',
  'pounds',
]);
/** A bare age ("she is 15") needs one of these right before it. */
const AGE_LINKS = new Set([
  'is',
  'was',
  'am',
  'are',
  'were',
  'turned',
  'turns',
  'turning',
  'aged',
  'age',
  'of',
  'at',
  'when',
]);
const PRONOUNS = new Set([
  'she',
  'her',
  'hers',
  'herself',
  'he',
  'him',
  'his',
  'himself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
]);

type TermIndex = Map<string, number[][]>;

/** Run-length view of a word: collapsed letters plus the length of each run. */
function runs(word: string): { key: string; counts: number[] } {
  let key = '';
  const counts: number[] = [];
  for (const c of word) {
    if (key.endsWith(c)) counts[counts.length - 1]!++;
    else {
      key += c;
      counts.push(1);
    }
  }
  return { key, counts };
}

/** Term lookup that tolerates stretched letters ("chiiild") but keeps "teen" distinct from "ten". */
function termIndex(terms: readonly string[]): TermIndex {
  const index: TermIndex = new Map();
  for (const term of terms) {
    const { key, counts } = runs(term);
    index.set(key, [...(index.get(key) ?? []), counts]);
  }
  return index;
}
const MAX_TERM_CHARS = 40;
const inIndex = (index: TermIndex, word: string): boolean => {
  if (word.length > MAX_TERM_CHARS) return false;
  const { key, counts } = runs(word);
  return (
    index.get(key)?.some((min) => min.every((m, i) => counts[i]! >= m)) ?? false
  );
};
const inSet = (set: ReadonlySet<string>, word: string) =>
  set.has(runs(word).key) || set.has(word);

const PROXIMITY = HARD_FLOOR_RULES['minor-sexual.proximity'];
const EXPLICIT = termIndex(HARD_FLOOR_RULES['csam.explicit-term'].terms);
const MINOR = termIndex(PROXIMITY.minorTerms);
const SEXUAL = termIndex(PROXIMITY.sexualTerms);
const SEX = termIndex(['sex']);
const LAID = termIndex(['laid']);
const BEFORE = termIndex(PROXIMITY.sexPhraseNeighbours.before);
const AFTER = termIndex(PROXIMITY.sexPhraseNeighbours.after);
const NOT_AFTER = termIndex(PROXIMITY.sexPhraseNeighbours.notAfter);
const LAID_BEFORE = termIndex(PROXIMITY.sexPhraseNeighbours.laidBefore);
const YOUTH_PREFIX = new Set<string>(PROXIMITY.youthPrefixes);
const YOUTH_NOUN = termIndex(PROXIMITY.youthNouns);

const ageValue = (raw: string) =>
  /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];

/** Every Unicode decimal digit (\\p{Nd}) mapped to its value. Digit runs are contiguous blocks of ten from zero. */
const UNICODE_DIGIT = (() => {
  const map = new Map<string, string>();
  let run = 0;
  for (let cp = 0; cp < 0x20000; cp++) {
    const c = String.fromCodePoint(cp);
    if (/\p{Nd}/u.test(c)) {
      map.set(c, String(run % 10));
      run++;
    } else run = 0;
  }
  return map;
})();

function ageMatch(match: string, a: string | undefined, b: string | undefined) {
  const value = ageValue(a ?? b ?? '');
  return value !== undefined && value < 18 ? ' minorage ' : match;
}

function normalizeText(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\p{Cf}+/gu, '')
    .toLowerCase();
  let s = '';
  for (const c of folded) s += CONFUSABLE.get(c) ?? UNICODE_DIGIT.get(c) ?? c;
  s = s.replace(/@/g, 'a').replace(/\$/g, 's');
  s = s.replace(DOT_SPELLING, '$1');
  s = s.replace(ONE_COMPOUND, (_m, w: string) => ` ${10 + NUMBER_WORDS[w]!} `);
  s = s.replace(AGE_PHRASE, (match, a?: string, b?: string) =>
    ageMatch(match, a, b),
  );
  s = s.replace(NO_OLDER_THAN, (match, a?: string) =>
    ageMatch(match, a, undefined),
  );
  s = s.replace(UNDER_EIGHTEEN, ' minorage ');
  for (const cue of SCHOOL_CUES) s = s.replace(cue, ' minorage ');
  for (const phrase of MINOR_PHRASES) s = s.replace(phrase, ' minorage ');
  return s;
}

/** Spellings of a word with digit look-alikes folded; "1" may be "i" or "l". */
function variants(word: string): string[] {
  if (!/\p{L}/u.test(word)) return [word];
  const base = word.replace(/[034578]/g, (d) => LEET[d]!);
  const ones = (base.match(/1/g) ?? []).length;
  if (ones === 0) return [base];
  if (ones > 3) return [base.replace(/1/g, 'i'), base.replace(/1/g, 'l')];
  let out = [''];
  for (const c of base)
    out =
      c === '1'
        ? out.flatMap((o) => [`${o}i`, `${o}l`])
        : out.map((o) => o + c);
  return out;
}

interface Tokens {
  words: string[];
  /** Sentence number of each word. */
  sentence: number[];
}

function tokenize(text: string): Tokens {
  const words: string[] = [];
  const sentence: number[] = [];
  let sent = 0;
  for (const m of text.matchAll(/([\p{L}\p{N}]+)([^\p{L}\p{N}]*)/gu)) {
    words.push(m[1]!);
    sentence.push(sent);
    if (/[.!?;\n]/.test(m[2]!)) sent++;
  }
  return { words, sentence };
}

const SHORT_PIECE = 2;
/** Longest run of short pieces joined back into one word ("s e x ua l"). */
const MAX_JOIN = 12;

interface Event {
  kind: 'minor' | 'sexual';
  pos: number;
  sentence: number;
  /** Minor word starts its sentence, so it is that sentence's subject. */
  subject: boolean;
}

/**
 * Finds minor and sexual references. A word is a single token, or a run of up to
 * MAX_JOIN short tokens joined together ("c h i l d", "s-e-x-ua-l"). Cost is
 * O(tokens x MAX_JOIN).
 */
function scan(tokens: Tokens): {
  explicit: boolean;
  events: Event[];
  pronounSentences: Set<number>;
} {
  const { words, sentence } = tokens;
  const base = words.map((w) => variants(w)[0]!);
  const pronounSentences = new Set<number>();
  base.forEach((w, i) => {
    if (PRONOUNS.has(w)) pronounSentences.add(sentence[i]!);
  });
  const events: Event[] = [];
  const sentenceStart: number[] = [];
  sentence.forEach((sent, i) => {
    if (sentenceStart[sent] === undefined) sentenceStart[sent] = i;
  });
  const emit = (kind: Event['kind'], pos: number) =>
    events.push({
      kind,
      pos,
      sentence: sentence[pos]!,
      subject: pos - sentenceStart[sentence[pos]!]! < PROXIMITY.subjectTokens,
    });
  for (let s = 0; s < words.length; s++) {
    let joined = '';
    for (let e = s; e < Math.min(words.length, s + MAX_JOIN); e++) {
      if (
        e > s &&
        (words[e]!.length > SHORT_PIECE || words[s]!.length > SHORT_PIECE)
      )
        break;
      joined += words[e];
      if (e > s && joined.length > MAX_TERM_CHARS) break;
      const prev = s > 0 ? base[s - 1]! : '';
      const prev2 = s > 1 ? base[s - 2]! : '';
      const next = e + 1 < words.length ? base[e + 1]! : '';
      let isMinor = false;
      let isSexual = false;
      for (const w of variants(joined)) {
        if (inIndex(EXPLICIT, w))
          return { explicit: true, events, pronounSentences };
        if (inIndex(MINOR, w)) isMinor = true;
        else if (w === 'age' && prev === 'under') isMinor = true;
        else if (YOUTH_PREFIX.has(prev) && inIndex(YOUTH_NOUN, w))
          isMinor = true;
        else if (e === s && bareAge(w, prev, prev2, next)) isMinor = true;
        else if (e === s && youthAdjacentAge(w, prev, next)) isMinor = true;
        if (inIndex(SEXUAL, w)) isSexual = true;
        else if (inIndex(SEX, w)) {
          if (
            (inIndex(BEFORE, prev) && !inIndex(NOT_AFTER, next)) ||
            inIndex(AFTER, next)
          )
            isSexual = true;
        } else if (inIndex(LAID, w) && inIndex(LAID_BEFORE, prev))
          isSexual = true;
      }
      if (isMinor) emit('minor', s);
      if (isSexual) emit('sexual', s);
    }
  }
  return { explicit: false, events, pronounSentences };
}

/** "she is 15", "was fifteen": a bare number 5 to 17 right after a link word, not followed by a unit. */
function bareAge(word: string, prev: string, prev2: string, next: string) {
  const value = ageValue(word);
  if (value === undefined || value < 5 || value > 17) return false;
  if (inSet(QUANTITY_UNITS, next)) return false;
  return (
    AGE_LINKS.has(prev) || (prev === 's' && (prev2 === 'she' || prev2 === 'he'))
  );
}

/** "girl 15", "15 girl": a bare number 5 to 17 next to a youth noun, not a quantity. */
function youthAdjacentAge(word: string, prev: string, next: string) {
  const value = ageValue(word);
  if (value === undefined || value < 5 || value > 17) return false;
  if (inSet(QUANTITY_UNITS, next)) return false;
  return inIndex(YOUTH_NOUN, prev) || inIndex(YOUTH_NOUN, next);
}

function minorNearSexual(
  events: readonly Event[],
  pronounSentences: ReadonlySet<number>,
): boolean {
  let lastMinor: Event | undefined;
  let lastSexual: Event | undefined;
  const near = (minor: Event, sexual: Event) => {
    const d = Math.abs(minor.pos - sexual.pos);
    const sd = Math.abs(minor.sentence - sexual.sentence);
    if (sd === 0 && d <= PROXIMITY.windowTokens) return true;
    if (sd >= 1 && sd <= 2 && d <= PROXIMITY.adjacentTokens) return true;
    if (d > PROXIMITY.carryTokens) return false;
    return (
      pronounSentences.has(sexual.sentence) ||
      (minor.subject && sexual.sentence - minor.sentence === 1)
    );
  };
  for (const ev of events) {
    if (ev.kind === 'minor') {
      if (lastSexual && near(ev, lastSexual)) return true;
      lastMinor = ev;
    } else {
      if (lastMinor && near(lastMinor, ev)) return true;
      lastSexual = ev;
    }
  }
  return false;
}

export function checkHardFloor(text: string): HardFloorResult {
  const blocked = (rule: string): HardFloorResult => ({
    blocked: true,
    rule,
    version: HARD_FLOOR_VERSION,
  });
  if (text.length > MAX_INPUT_CHARS) return blocked('input.over-limit');
  const { explicit, events, pronounSentences } = scan(
    tokenize(normalizeText(text)),
  );
  if (explicit) return blocked('csam.explicit-term');
  if (minorNearSexual(events, pronounSentences))
    return blocked('minor-sexual.proximity');
  if (
    text.length <= PROXIMITY.shortMessageChars &&
    events.some((e) => e.kind === 'minor') &&
    events.some((e) => e.kind === 'sexual')
  )
    return blocked('minor-sexual.proximity');
  return { blocked: false, version: HARD_FLOOR_VERSION };
}
