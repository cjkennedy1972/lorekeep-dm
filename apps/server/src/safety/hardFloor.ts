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
 * Message-level taint: once a minor reference appears anywhere in a message, any sexual
 * term anywhere in that same message blocks, before or after it. No sentence or token
 * distance applies. Documented allowance: a minor term with no sexual term passes
 * ("the baby dragon sleeps"). A youth word (youth, youngster, young girl) directly next to
 * an explicit adult marker (adult, grown) does not taint. Core child words and stated
 * ages never take that allowance. One linear pass over at most MAX_INPUT_CHARS characters.
 *
 * Known limits (see HARD_FLOOR_KNOWN_MISSES): other languages, slang beyond the list,
 * bare-noun minors, images.
 */

export const HARD_FLOOR_VERSION = '2026-10-12.11';

/** Callers cap input far below this (ws text 4000, names 80). Longer input is blocked, never scanned. Equals the output turn cap (DEFAULT_MAX_TURN_CHARS) so a whole turn is scanned. */
export const MAX_INPUT_CHARS = 30_000;

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
      'childlike',
      'schoolgirl',
      'schoolgirls',
      'schoolboy',
      'schoolboys',
      'schoolchild',
      'schoolchildren',
      'stepchild',
      'stepchildren',
      'tot',
      'tots',
      'nipper',
      'nippers',
      'bairn',
      'bairns',
      'kidz',
    ],
    /** Youth words: a minor only when no explicit adult marker touches them (module header). */
    youthWords: [
      'youth',
      'youths',
      'youngster',
      'youngsters',
      'youngling',
      'younglings',
    ],
    /** "young girl", "tiny boy": the noun counts only right after one of these. */
    youthPrefixes: ['young', 'little', 'tiny', 'small', 'wee'],
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
    /** A bare number 1 to 17 right next to one of these is an age: "girl, 12," "woman (13)". */
    personNouns: [
      'girl',
      'girls',
      'boy',
      'boys',
      'lad',
      'lads',
      'lass',
      'lasses',
      'woman',
      'women',
      'man',
      'men',
      'lady',
      'ladies',
      'maiden',
      'maidens',
      'female',
      'females',
      'male',
      'males',
    ],
    adultMarkers: ['adult', 'adults', 'grown', 'grownup', 'grownups'],
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
      'buttocks',
      'crotch',
      'groin',
      'anal',
      'boobs',
      'tits',
      'pussy',
      'cock',
      'cocks',
      'fuck',
      'fucks',
      'fucked',
      'fucking',
      'fucker',
      'fuckers',
      'fuckin',
      'deflower',
      'deflowers',
      'deflowered',
      'deflowering',
      'virginity',
      'intercourse',
      'hentai',
      'grope',
      'gropes',
      'groped',
      'groping',
    ],
    /** "undress her", "strip the girl": sexual only with an object. "undressed for bed" is not. */
    undressTerms: [
      'undress',
      'undresses',
      'undressed',
      'undressing',
      'strip',
      'strips',
      'stripped',
      'stripping',
    ],
    undressObjects: ['her', 'him', 'them', 'the', 'his', 'their'],
    /** "sex" counts only in these phrases: "have sex", "in sex", "sex with", "sex scene"; "got laid" likewise. */
    sexPhraseNeighbours: {
      before: ['have', 'has', 'had', 'having', 'in', 'for'],
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
        'abuse',
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
  `\\b${AGE_NUMBER}(?:[\\s-]*(?:yo|y\\/o|y\\.o\\.?|(?:years?|yrs?)[\\s-]*old|years?[\\s-]*of[\\s-]*age))${WORD_END}|\\b(?:age|aged)[\\s:]*${AGE_NUMBER}${WORD_END}`,
  'giu',
);
const NO_OLDER_THAN = new RegExp(
  `\\b(?:no|not)[\\s-]+older[\\s-]+than[\\s-]+${AGE_NUMBER}${WORD_END}`,
  'giu',
);
const ONE_COMPOUND = new RegExp(
  `\\bone-(${Object.keys(NUMBER_WORDS).slice(0, 9).join('|')})\\b`,
  'g',
);
/** "one-eight" and "one-nine" read as 18 or 19 or as a split 1-8 / 1-9 age: ambiguous, so minor. */
const ONE_COMPOUND_AMBIGUOUS = new Set(['eight', 'nine']);
/** Roman numerals 2 to 17 only: "i" and "x" alone collide with the pronoun and common words. */
const ROMAN_AGE = 'ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv|xvi|xvii';
/** Euphemisms that imply a minor. "youth" and "tiny" are not here: adults use both words. */
const MINOR_PHRASES: readonly RegExp[] = [
  /\bbarely[\s-]+(?:legal|out[\s-]+of[\s-]+school)\b/g,
  /\bschool[\s-]+uniform\b/g,
  /\byoung[\s-]+looking\b/g,
  /\blittle[\s-]+one\b/g,
  /\bschool[\s-]+age[ds]?\b/g,
];
/** "c.h.i.l.d", "sex.ual": a dot between letters is a split, so the pieces join in scan(). */
const DOT_SPLIT = /(?<=\p{L})\.(?=\p{L})/gu;
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
  'ages',
  'of',
  'at',
  'when',
  'looks',
  'looked',
]);
const ROMAN_AGE_PHRASE = new RegExp(
  `\\b(${ROMAN_AGE})(?=[\\s-]*(?:yo\\b|y\\/o|y\\.o|(?:years?|yrs?)[\\s-]*old))`,
  'gu',
);
const ROMAN_LINKED = new RegExp(
  `(?<=\\b(?:${[...AGE_LINKS].join('|')})\\s+)(${ROMAN_AGE})${WORD_END}`,
  'gu',
);
const termIndex = (terms: readonly string[]) => new Set(terms);
const inIndex = (index: Set<string>, w: string) => index.has(w);
/** Longest vocabulary entry plus slack; bounds the joined-piece length in scan(). */
const MAX_TERM_CHARS = 24;

const PROXIMITY = HARD_FLOOR_RULES['minor-sexual.proximity'];
const UNIT_AFTER = `(?!\\s*(?:${[...QUANTITY_UNITS].join('|')})${WORD_END})`;
const SEXUAL_AFTER = `(?=[^\\p{L}\\p{N}]*(?:(?:years?|yrs?)[^\\p{L}\\p{N}]*(?:old[^\\p{L}\\p{N}]*)?)?(?:and\\s+)?(?:${[...PROXIMITY.sexualTerms, ...PROXIMITY.undressTerms, 'sex'].join('|')})${WORD_END})`;
/**
 * "Mira 12, ..." / "Mira; 12 ..." after a letter. Punctuation separators need no tail;
 * a bare space needs a sexual or undress word right after the number (plus optional "and"),
 * so "rolled a 15 to seduce" and "Two girls and 9 goblins" stay allowed.
 */
const NAME_AGE = new RegExp(
  `(\\p{L})(?:\\s*[^\\p{L}\\p{N}\\s]{1,3}\\s*${AGE_NUMBER}${WORD_END}${UNIT_AFTER}|\\s+${AGE_NUMBER}${WORD_END}${SEXUAL_AFTER})`,
  'gu',
);
const EXPLICIT = termIndex(HARD_FLOOR_RULES['csam.explicit-term'].terms);
const MINOR = termIndex(PROXIMITY.minorTerms);
const YOUTH_WORD = termIndex(PROXIMITY.youthWords);
const SEXUAL = termIndex(PROXIMITY.sexualTerms);
const SEX = termIndex(['sex']);
const LAID = termIndex(['laid']);
const BEFORE = termIndex(PROXIMITY.sexPhraseNeighbours.before);
const AFTER = termIndex(PROXIMITY.sexPhraseNeighbours.after);
const NOT_AFTER = termIndex(PROXIMITY.sexPhraseNeighbours.notAfter);
const LAID_BEFORE = termIndex(PROXIMITY.sexPhraseNeighbours.laidBefore);
const UNDRESS = termIndex(PROXIMITY.undressTerms);
const UNDRESS_OBJECT = new Set<string>(PROXIMITY.undressObjects);
const MAKE = termIndex(['make', 'makes', 'made', 'making']);
const CLOTHES = termIndex(['clothes', 'clothing', 'garments', 'underwear']);
const POSSESSIVE = new Set<string>([
  'her',
  'his',
  'their',
  'its',
  'my',
  'your',
]);
const REMOVE = termIndex([
  'remove',
  'removes',
  'removed',
  'removing',
  'take',
  'takes',
  'took',
  'taking',
]);
const YOUTH_PREFIX = new Set<string>(PROXIMITY.youthPrefixes);
const YOUTH_NOUN = termIndex(PROXIMITY.youthNouns);
const PERSON_NOUN = termIndex(PROXIMITY.personNouns);
const ADULT_MARKER = new Set<string>(PROXIMITY.adultMarkers);
/** Tokens drop punctuation, so "&" and "," are already gaps; only words need listing here. */
const FILLER = termIndex([
  'and',
  'or',
  'with',
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
]);
const FILLER_WINDOW = 2;

const minorWordAt = (base: string[], i: number) =>
  inIndex(MINOR, base[i]!) || inIndex(YOUTH_WORD, base[i]!);
/** Phrase ends at i: "child", "young girl" (noun at i, prefix at i - 1). */
const minorPhraseEndsAt = (base: string[], i: number) =>
  minorWordAt(base, i) ||
  (i > 0 && YOUTH_PREFIX.has(base[i - 1]!) && inIndex(YOUTH_NOUN, base[i]!));
/** Phrase starts at i: "child", "young girl" (prefix at i, noun at i + 1). */
const minorPhraseStartsAt = (base: string[], i: number) =>
  minorWordAt(base, i) ||
  (i + 1 < base.length &&
    YOUTH_PREFIX.has(base[i]!) &&
    inIndex(YOUTH_NOUN, base[i + 1]!));
/** Minor phrase before `s`, separated from it only by up to FILLER_WINDOW filler words. */
function minorBefore(base: string[], s: number): boolean {
  for (let n = s - 1, k = 0; n >= 0 && k <= FILLER_WINDOW; n--, k++) {
    if (minorPhraseEndsAt(base, n)) return true;
    if (!inIndex(FILLER, base[n]!)) return false;
  }
  return false;
}
/** Minor phrase after `e`, separated from it only by up to FILLER_WINDOW filler words. */
function minorAfter(base: string[], e: number): boolean {
  for (let n = e + 1, k = 0; n < base.length && k <= FILLER_WINDOW; n++, k++) {
    if (minorPhraseStartsAt(base, n)) return true;
    if (!inIndex(FILLER, base[n]!)) return false;
  }
  return false;
}

const wordValue = (w: string) =>
  Object.hasOwn(NUMBER_WORDS, w) ? NUMBER_WORDS[w] : undefined;
const ageValue = (raw: string) =>
  /^\d+$/.test(raw) ? Number(raw) : wordValue(raw);

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

function foldCharacters(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(?<=\p{L})\p{Cf}+(?=\p{N})|(?<=\p{N})\p{Cf}+(?=\p{L})/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .toLowerCase();
  let s = '';
  for (const c of folded) s += CONFUSABLE.get(c) ?? UNICODE_DIGIT.get(c) ?? c;
  s = s.replace(/@/g, 'a').replace(/\$/g, 's').replace(/\*/g, 'e');
  return s;
}

function normalizeText(input: string): string {
  return normalizeFoldedText(foldCharacters(input));
}

/** Apply rule normalization to text already returned by foldCharacters. */
function normalizeFoldedText(input: string): string {
  let s = input;
  s = s.replace(/(?<=\p{L})['’‘ʼʻʹꞌ`´′]s(?!\p{L})/gu, '');
  s = s.replace(ONE_COMPOUND, (_m, w: string) =>
    ONE_COMPOUND_AMBIGUOUS.has(w) ? ' minorage ' : ` ${10 + NUMBER_WORDS[w]!} `,
  );
  s = s.replace(AGE_PHRASE, (match, a?: string, b?: string) =>
    ageMatch(match, a, b),
  );
  s = s.replace(NO_OLDER_THAN, (match, a?: string) =>
    ageMatch(match, a, undefined),
  );
  s = s.replace(NAME_AGE, (match, anchor: string, a?: string, b?: string) => {
    const normalized = ageMatch(match, a, b);
    // NAME_AGE consumes the letter anchoring the name/age boundary. Preserve it;
    // otherwise "Naked, 12" becomes "Nake minorage" and loses the cue.
    return normalized === match ? match : anchor + normalized;
  });
  s = s.replace(ROMAN_AGE_PHRASE, ' minorage ');
  s = s.replace(ROMAN_LINKED, ' minorage ');
  s = s.replace(DOT_SPLIT, ' ');
  s = s.replace(UNDER_EIGHTEEN, ' minorage ');
  for (const cue of SCHOOL_CUES) s = s.replace(cue, ' minorage ');
  for (const phrase of MINOR_PHRASES) s = s.replace(phrase, ' minorage ');
  return s;
}

const VARIANT_CACHE = new Map<string, string[]>();
const VARIANT_CACHE_MAX = 4096;
/** Total characters (keys and forms, UTF-16 units) held by the cache: at most ~4 MB, 2 bytes per unit. */
const VARIANT_CACHE_MAX_CHARS = 2_000_000;
let variantCacheChars = 0;

/** Spellings of a word with digit look-alikes folded; "1" may be "i" or "l". Memoized: a turn repeats tokens. */
function variants(word: string): string[] {
  const hit = VARIANT_CACHE.get(word);
  if (hit) return hit;
  const forms = wordForms(word);
  const collapsed = forms.map((f) => f.replace(/(\p{L})\1{2,}/gu, '$1'));
  const out = [...new Set([...forms, ...collapsed])];
  const cost = word.length + out.reduce((n, f) => n + f.length, 0);
  if (cost > VARIANT_CACHE_MAX_CHARS) return out;
  if (
    VARIANT_CACHE.size >= VARIANT_CACHE_MAX ||
    variantCacheChars + cost > VARIANT_CACHE_MAX_CHARS
  ) {
    VARIANT_CACHE.clear();
    variantCacheChars = 0;
  }
  VARIANT_CACHE.set(word, out);
  variantCacheChars += cost;
  return out;
}

export function variantCacheStats(): { entries: number; chars: number } {
  return { entries: VARIANT_CACHE.size, chars: variantCacheChars };
}

function wordForms(word: string): string[] {
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

/** Longest run of pieces joined back into one word ("s e x ua l", "s*xual"). */
const MAX_JOIN = 12;

/** A bare number 1 to 17 (digits or words). Needs an age link or a person noun to count. */
function bareAge(word: string): boolean {
  const v = /^\d+$/.test(word) ? Number(word) : wordValue(word);
  return v !== undefined && v >= 1 && v <= 17;
}

/** Next to a person noun ("two boys" is adult prose), a word number counts only from five up. */
function nounAge(word: string): boolean {
  if (/^\d+$/.test(word)) return bareAge(word);
  const v = wordValue(word);
  return v !== undefined && v >= 5 && v <= 17;
}

export interface HardFloorFlags {
  explicit: boolean;
  minor: boolean;
  sexual: boolean;
}

const SCAN_CACHE_MAX = 4096;
const SCAN_CACHE_MAX_CHARS = 2_000_000;
const SCAN_CACHE = new Map<string, HardFloorFlags>();
let scanCacheChars = 0;

/**
 * Message-level verdict. `minor` is set by any minor reference that is not a youth word
 * next to an adult marker; `sexual` by any sexual term. The caller blocks when both hold.
 * Only match starts in [from, to) set flags; neighbours are read from all of `words`.
 * Each word position joins at most MAX_JOIN pieces up to MAX_TERM_CHARS, so cost is O(tokens x MAX_JOIN).
 */
export function scanFlags(
  words: string[],
  from: number,
  to: number,
): HardFloorFlags {
  // Results only depend on the scanned starts plus bounded left/right context.
  // Key that slice, not the whole carry: when a one-character chunk extends the
  // still-tentative tail, settled starts are unchanged and should hit this cache.
  // Three tokens cover prev3/minorBefore; one more preserves a youth-prefix
  // immediately before the earliest minor-before candidate.
  const keyFrom = Math.max(0, from - 4);
  const keyTo = Math.min(words.length, to + MAX_JOIN + FILLER_WINDOW + 3);
  const key = `${from - keyFrom}:${to - keyFrom}:${words
    .slice(keyFrom, keyTo)
    .join('\u001f')}`;
  if (key.length <= 8_192) {
    const cached = SCAN_CACHE.get(key);
    if (cached) return cached;
  }
  const base = words.map((w) => variants(w)[0]!);
  let minor = false;
  let sexual = false;
  for (let s = from; s < to; s++) {
    let joined = '';
    for (let e = s; e < Math.min(words.length, s + MAX_JOIN); e++) {
      joined += words[e];
      if (e > s && joined.length > MAX_TERM_CHARS) break;
      const prev = s > 0 ? base[s - 1]! : '';
      const prev2 = s > 1 ? base[s - 2]! : '';
      const prev3 = s > 2 ? base[s - 3]! : '';
      const next = e + 1 < words.length ? base[e + 1]! : '';
      let core = false;
      let youth = false;
      let sexualHere = false;
      for (const w of variants(joined)) {
        if (inIndex(EXPLICIT, w))
          return remember({ explicit: true, minor, sexual });
        if (inIndex(MINOR, w)) core = true;
        else if (w === 'age' && prev === 'under') core = true;
        else if (inIndex(YOUTH_WORD, w)) youth = true;
        else if (YOUTH_PREFIX.has(prev) && inIndex(YOUTH_NOUN, w)) youth = true;
        else if (e === s && bareAge(w) && !QUANTITY_UNITS.has(next)) {
          if (
            AGE_LINKS.has(prev) ||
            (prev === 's' && (prev2 === 'she' || prev2 === 'he')) ||
            ((inIndex(PERSON_NOUN, prev) || inIndex(PERSON_NOUN, next)) &&
              nounAge(w))
          )
            core = true;
        }
        if (inIndex(SEXUAL, w)) sexualHere = true;
        else if (inIndex(SEX, w)) {
          if (
            (inIndex(BEFORE, prev) && !inIndex(NOT_AFTER, next)) ||
            inIndex(AFTER, next) ||
            inIndex(MINOR, prev) ||
            (prev === 's' && inIndex(MINOR, prev2)) ||
            inIndex(MINOR, next) ||
            inIndex(YOUTH_WORD, prev) ||
            inIndex(YOUTH_WORD, next) ||
            (YOUTH_PREFIX.has(prev2) && inIndex(YOUTH_NOUN, prev)) ||
            (prev === 's' &&
              YOUTH_PREFIX.has(prev3) &&
              inIndex(YOUTH_NOUN, prev2)) ||
            minorBefore(base, s) ||
            minorAfter(base, e)
          )
            sexualHere = true;
        } else if (inIndex(LAID, w) && inIndex(LAID_BEFORE, prev))
          sexualHere = true;
        else if (inIndex(UNDRESS, w) && UNDRESS_OBJECT.has(next))
          sexualHere = true;
        else if (w === 'love' && inIndex(MAKE, prev)) sexualHere = true;
        else if (
          inIndex(CLOTHES, w) &&
          POSSESSIVE.has(prev) &&
          (inIndex(REMOVE, prev2) ||
            (prev2 === 'off' && inIndex(REMOVE, prev3)))
        )
          sexualHere = true;
      }
      if (core || (youth && !ADULT_MARKER.has(prev) && !ADULT_MARKER.has(next)))
        minor = true;
      if (sexualHere) sexual = true;
      if (minor && sexual) return remember({ explicit: false, minor, sexual });
    }
  }
  return remember({ explicit: false, minor, sexual });

  function remember(flags: HardFloorFlags): HardFloorFlags {
    if (key.length > 8_192) return flags;
    if (
      SCAN_CACHE.size >= SCAN_CACHE_MAX ||
      scanCacheChars + key.length > SCAN_CACHE_MAX_CHARS
    ) {
      SCAN_CACHE.clear();
      scanCacheChars = 0;
    }
    SCAN_CACHE.set(key, flags);
    scanCacheChars += key.length;
    return flags;
  }
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function verdictOf(flags: HardFloorFlags): HardFloorResult {
  if (flags.explicit)
    return {
      blocked: true,
      rule: 'csam.explicit-term',
      version: HARD_FLOOR_VERSION,
    };
  if (flags.minor && flags.sexual)
    return {
      blocked: true,
      rule: 'minor-sexual.proximity',
      version: HARD_FLOOR_VERSION,
    };
  return { blocked: false, version: HARD_FLOOR_VERSION };
}

export function checkHardFloor(text: string): HardFloorResult {
  if (text.length > MAX_INPUT_CHARS)
    return {
      blocked: true,
      rule: 'input.over-limit',
      version: HARD_FLOOR_VERSION,
    };
  const words = tokenize(normalizeText(compactTurnWindow(text)));
  return verdictOf(scanFlags(words, 0, words.length));
}

/** Raw characters kept between chunks so a term that straddles a cut is re-read whole. */
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const MAX_CARRY_TOKEN_CHARS = MAX_TERM_CHARS + MAX_JOIN + 1;
const LONG_TOKEN_MARKER = 'ab'.repeat(Math.ceil(MAX_CARRY_TOKEN_CHARS / 2));
/** Last tokens of a window: their flags stay tentative until more text arrives. */
const TURN_TAIL_TOKENS = MAX_JOIN + FILLER_WINDOW + 2;
/** First tokens of a window cut mid-turn: no left context, so they set no flags. */
const TURN_LEFT_TOKENS = 3;
/** Enough tokens for the unsettled tail, left context and joined-token lookahead. */
const TURN_CARRY_TOKENS = MAX_JOIN + TURN_TAIL_TOKENS + TURN_LEFT_TOKENS + 2;
function compactLongToken(token: string): string {
  if ([...token].length <= MAX_CARRY_TOKEN_CHARS) return token;
  const hasLetters = /\p{L}/u.test(token);
  const runs = [...token.matchAll(/([\p{L}\p{N}])\1*/gu)].map(([run, char]) => {
    const repeatable =
      /\p{L}/u.test(char!) || (hasLetters && /[034578]/.test(char!));
    const limit = char === '1' ? 4 : repeatable ? 3 : Infinity;
    return [...run!].slice(0, limit).join('');
  });
  const compacted = runs.join('');
  const collapsedForms = wordForms(compacted).map((form) =>
    form.replace(/(\p{L})\1{2,}/gu, '$1'),
  );
  if (collapsedForms.every((form) => form.length > MAX_CARRY_TOKEN_CHARS))
    return LONG_TOKEN_MARKER;
  const padChar = [...token].find((char) => /\p{L}/u.test(char));
  if (!padChar) return LONG_TOKEN_MARKER;
  const chars = [...compacted];
  const padAt = chars.indexOf(padChar);
  return [
    ...chars.slice(0, padAt),
    ...Array.from({ length: MAX_CARRY_TOKEN_CHARS + 1 }, () => padChar),
    ...chars.slice(padAt),
  ].join('');
}

/**
 * Bound non-word runs. Hard-floor rules are token-based except NAME_AGE's punctuation
 * branch, which accepts at most three punctuation marks before an age. Retaining up to
 * three marks and one space on either side preserves every such match; collapsing mixed
 * separator runs can add matches, but cannot remove a token sequence or age marker.
 */
function compactSeparators(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, (run) => {
    if (/^\s+$/u.test(run)) return ' ';
    // Preserve a dangling high surrogate at the edge of a chunk: a low
    // surrogate in the next push may complete an astral letter after folding.
    const trailingHigh = /[\uD800-\uDBFF]$/u.test(run) ? run.slice(-1) : '';
    const marks = [...(trailingHigh ? run.slice(0, -1) : run)]
      .filter((char) => !/\s/u.test(char))
      .slice(0, 3)
      .join('');
    return `${/^\s/u.test(run) ? ' ' : ''}${marks}${trailingHigh}${/\s$/u.test(run) ? ' ' : ''}`;
  });
}

/** Keep repeated pushes bounded while preserving word variants and rule-relevant separators. */
function compactTurnWindow(text: string): string {
  const trailingFormat = /\p{Cf}+$/u.exec(text)?.[0] ?? '';
  const body = trailingFormat ? text.slice(0, -trailingFormat.length) : text;
  const folded = foldCharacters(body);
  const compacted = compactSeparators(
    folded.replace(/[\p{L}\p{N}]+/gu, compactLongToken),
  );
  return compacted + (trailingFormat ? trailingFormat[0] : '');
}

/** Fast path for the common one-ASCII-character stream delta. The carry is already
 * folded/compacted, so only its final token or separator run can have changed. */
function appendAsciiChar(
  carry: string,
  input: string,
): { window: string; startsWord: boolean } | undefined {
  if (input.length !== 1 || input.charCodeAt(0) > 0x7f) return undefined;
  // A preserved trailing format character has cross-boundary folding rules.
  const lastChar = carry.at(-1) ?? '';
  if (
    lastChar &&
    lastChar.charCodeAt(0) > 0x7f &&
    /\p{Cf}$/u.test(carry.slice(-2))
  )
    return undefined;
  let code = input.charCodeAt(0);
  if (code >= 65 && code <= 90) code += 32;
  if (code === 64) code = 97;
  else if (code === 36) code = 115;
  else if (code === 42) code = 101;
  const char = String.fromCharCode(code);
  const wordChar = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
  const lastCode = lastChar.charCodeAt(0);
  const lastIsWord =
    lastCode <= 0x7f
      ? (lastCode >= 48 && lastCode <= 57) ||
        (lastCode >= 65 && lastCode <= 90) ||
        (lastCode >= 97 && lastCode <= 122)
      : /[\p{L}\p{N}]/u.test(lastChar);
  if (wordChar) {
    if (!lastIsWord) return { window: carry + char, startsWord: true };
    let tokenStart = carry.length;
    while (tokenStart > 0) {
      const c = carry.charCodeAt(tokenStart - 1);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122)
      ) {
        tokenStart--;
        continue;
      }
      if (c > 0x7f) {
        tokenStart = carry.search(/[\p{L}\p{N}]+$/u);
      }
      break;
    }
    const token = carry.slice(tokenStart);
    return {
      window: carry.slice(0, tokenStart) + compactLongToken(token + char),
      startsWord: false,
    };
  }

  const whitespace = code === 32 || (code >= 9 && code <= 13) || code === 160;
  if (whitespace) {
    const endsWithWhitespace =
      lastCode === 32 || (lastCode >= 9 && lastCode <= 13) || lastCode === 160;
    return {
      window: endsWithWhitespace ? carry : carry + ' ',
      startsWord: false,
    };
  }

  if (!carry || lastIsWord) return { window: carry + char, startsWord: false };
  const separatorStart = carry.search(/[^\p{L}\p{N}]+$/u);
  return {
    window:
      carry.slice(0, separatorStart) +
      compactSeparators(carry.slice(separatorStart) + char),
    startsWord: false,
  };
}

export interface HardFloorTurn {
  push(chunk: string): HardFloorResult & { sensitive: boolean };
  /** Close the turn and include the final unsettled tail in its verdict. */
  finish(): HardFloorResult & { sensitive: boolean };
}

/**
 * Start of a token-count-bounded carry. `compactTurnWindow` has already bounded each token
 * and separator run, so a separator-only suffix is bounded too. Returns 0 when nothing drops.
 */
function carryStart(window: string): number {
  const tokens = [...window.matchAll(TOKEN_RE)];
  return tokens.length > TURN_CARRY_TOKENS
    ? tokens[tokens.length - TURN_CARRY_TOKENS]!.index!
    : 0;
}

/**
 * Incremental checkHardFloor over one turn. Each push scans the carry plus the new chunk.
 * Flags from settled tokens are accumulated and never withdrawn; the tail is recomputed
 * on every push and counts toward the verdict without being kept. The sticky `sensitive`
 * visibility latch is separate from the recomputed sexual flag. Once blocked, stays blocked.
 */
export function createHardFloorTurn(): HardFloorTurn {
  const settled: HardFloorFlags = {
    explicit: false,
    minor: false,
    sexual: false,
  };
  let total = 0;
  let carry = '';
  let carryWords = 0;
  let dropped = false;
  let sensitive = false;
  let blockedResult: HardFloorResult | null = null;
  let tailFlags: HardFloorFlags = {
    explicit: false,
    minor: false,
    sexual: false,
  };
  let finished = false;
  let finishResult: HardFloorResult | null = null;
  return {
    push(chunk) {
      if (finished) {
        const result: HardFloorResult = {
          blocked: true,
          rule: 'input.over-limit',
          version: HARD_FLOOR_VERSION,
        };
        blockedResult = result;
        finishResult = result;
        return { ...result, sensitive };
      }
      if (blockedResult) return { ...blockedResult, sensitive };
      total += chunk.length;
      if (total > MAX_INPUT_CHARS) {
        blockedResult = {
          blocked: true,
          rule: 'input.over-limit',
          version: HARD_FLOOR_VERSION,
        };
        return { ...blockedResult, sensitive };
      }
      const atTurnStart = !dropped;
      const prevCarry = carry;
      const fast = appendAsciiChar(prevCarry, chunk);
      const window = fast?.window ?? compactTurnWindow(prevCarry + chunk);
      let cut = 0;
      if (fast !== undefined) {
        if (fast.startsWord) carryWords++;
        if (carryWords > TURN_CARRY_TOKENS) {
          cut = carryStart(window);
          carryWords = tokenize(window.slice(cut)).length;
        }
      } else {
        cut = carryStart(window);
        carryWords = tokenize(window.slice(cut)).length;
      }
      if (cut > 0) dropped = true;
      carry = window.slice(cut);
      const words = tokenize(normalizeFoldedText(window));
      const n = words.length;
      const lo = atTurnStart ? 0 : Math.min(TURN_LEFT_TOKENS, n);
      const hi = Math.max(lo, n - TURN_TAIL_TOKENS);
      const fixed = scanFlags(
        words,
        // The carry includes left context, the unsettled tail and join lookahead.
        // Normalization can collapse tokens, not add them, so this range always
        // starts before `lo`; rescanning from `lo` avoids re-tokenizing carry.
        lo,
        hi,
      );
      settled.explicit ||= fixed.explicit;
      settled.minor ||= fixed.minor;
      settled.sexual ||= fixed.sexual;
      const tail = scanFlags(words, hi, n);
      tailFlags = tail;
      // Hold output as soon as a possible sexual or explicit cue is seen, but do not
      // block on tentative tail flags until another chunk settles them or finish() closes
      // the turn. This prevents chunk boundaries from turning "youth adult" into a minor.
      // Either half can arrive first. Hold visibility after a minor cue too,
      // because a sexual cue later in the turn can complete the message-level rule.
      sensitive ||=
        settled.minor ||
        tail.minor ||
        settled.sexual ||
        tail.sexual ||
        settled.explicit ||
        tail.explicit;
      const result = verdictOf(settled);
      if (result.blocked) blockedResult = result;
      return { ...result, sensitive };
    },
    finish() {
      if (finishResult) return { ...finishResult, sensitive };
      finished = true;
      const result =
        blockedResult ??
        verdictOf({
          explicit: settled.explicit || tailFlags.explicit,
          minor: settled.minor || tailFlags.minor,
          sexual: settled.sexual || tailFlags.sexual,
        });
      if (result.blocked) blockedResult = result;
      finishResult = result;
      return { ...result, sensitive };
    },
  };
}
