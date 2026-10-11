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

export const HARD_FLOOR_VERSION = '2026-10-10.7';

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
const POSSESSIVE = new Set<string>(['her', 'his', 'their', 'its', 'my', 'your']);
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

function normalizeText(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/(?<=\p{L})\p{Cf}+(?=\p{N})|(?<=\p{N})\p{Cf}+(?=\p{L})/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .toLowerCase()
    .replace(/(?<=\p{L})['’‘ʼʻʹꞌ`´′]s(?!\p{L})/gu, '');
  let s = '';
  for (const c of folded) s += CONFUSABLE.get(c) ?? UNICODE_DIGIT.get(c) ?? c;
  s = s.replace(/@/g, 'a').replace(/\$/g, 's').replace(/\*/g, 'e');
  s = s.replace(ONE_COMPOUND, (_m, w: string) =>
    ONE_COMPOUND_AMBIGUOUS.has(w) ? ' minorage ' : ` ${10 + NUMBER_WORDS[w]!} `,
  );
  s = s.replace(AGE_PHRASE, (match, a?: string, b?: string) =>
    ageMatch(match, a, b),
  );
  s = s.replace(NO_OLDER_THAN, (match, a?: string) =>
    ageMatch(match, a, undefined),
  );
  s = s.replace(NAME_AGE, (match, _l: string, a?: string, b?: string) =>
    ageMatch(match, a, b),
  );
  s = s.replace(ROMAN_AGE_PHRASE, ' minorage ');
  s = s.replace(ROMAN_LINKED, ' minorage ');
  s = s.replace(DOT_SPLIT, ' ');
  s = s.replace(UNDER_EIGHTEEN, ' minorage ');
  for (const cue of SCHOOL_CUES) s = s.replace(cue, ' minorage ');
  for (const phrase of MINOR_PHRASES) s = s.replace(phrase, ' minorage ');
  return s;
}

/** Spellings of a word with digit look-alikes folded; "1" may be "i" or "l". */
function variants(word: string): string[] {
  const forms = wordForms(word);
  const collapsed = forms.map((f) => f.replace(/(\p{L})\1{2,}/gu, '$1'));
  return [...new Set([...forms, ...collapsed])];
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

/**
 * Message-level verdict. `minor` is set by any minor reference that is not a youth word
 * next to an adult marker; `sexual` by any sexual term. The caller blocks when both hold.
 * Each word position joins at most MAX_JOIN pieces up to MAX_TERM_CHARS, so cost is O(tokens x MAX_JOIN).
 */
function scan(words: string[]): {
  explicit: boolean;
  minor: boolean;
  sexual: boolean;
} {
  const base = words.map((w) => variants(w)[0]!);
  let minor = false;
  let sexual = false;
  for (let s = 0; s < words.length; s++) {
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
        if (inIndex(EXPLICIT, w)) return { explicit: true, minor, sexual };
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
            (prev === 's' && YOUTH_PREFIX.has(prev3) && inIndex(YOUTH_NOUN, prev2))
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
          (inIndex(REMOVE, prev2) || (prev2 === 'off' && inIndex(REMOVE, prev3)))
        )
          sexualHere = true;
      }
      if (core || (youth && !ADULT_MARKER.has(prev) && !ADULT_MARKER.has(next)))
        minor = true;
      if (sexualHere) sexual = true;
      if (minor && sexual) return { explicit: false, minor, sexual };
    }
  }
  return { explicit: false, minor, sexual };
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function checkHardFloor(text: string): HardFloorResult {
  const blocked = (rule: string): HardFloorResult => ({
    blocked: true,
    rule,
    version: HARD_FLOOR_VERSION,
  });
  if (text.length > MAX_INPUT_CHARS) return blocked('input.over-limit');
  const { explicit, minor, sexual } = scan(tokenize(normalizeText(text)));
  if (explicit) return blocked('csam.explicit-term');
  if (minor && sexual) return blocked('minor-sexual.proximity');
  return { blocked: false, version: HARD_FLOOR_VERSION };
}
