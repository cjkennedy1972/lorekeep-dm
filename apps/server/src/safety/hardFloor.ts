/**
 * Deterministic hard-floor input rules (R-S2, R-S8, ADR-007, ADR-016).
 *
 * Scope: sexual content involving minors. Rules only. No model call, no tier input:
 * the verdict depends on the text alone, so it is identical at every content tier.
 *
 * Limits: this is a conservative keyword and proximity check. It has false negatives
 * (slang, coreference across sentences, non-sexual nudity framing, unlisted obfuscation).
 * The LLM judge (M3-07) is the second layer. These rules alone do not satisfy R-S2.
 */

export const HARD_FLOOR_VERSION = '2026-10-10.1';

export const HARD_FLOOR_RULES = {
  'csam.explicit-term': {
    category: 'sexual-content-involving-minors',
    terms: [
      'loli',
      'lolis',
      'lolicon',
      'shota',
      'shotacon',
      'csam',
      'childporn',
      'kiddieporn',
      'kiddyporn',
    ],
  },
  'minor-sexual.proximity': {
    category: 'sexual-content-involving-minors',
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
      'teen',
      'teens',
      'teenage',
      'teenaged',
      'teenager',
      'teenagers',
      'adolescent',
      'adolescents',
      'preteen',
      'preteens',
      'prepubescent',
      'toddler',
      'toddlers',
      'infant',
      'infants',
      'juvenile',
      'juveniles',
      'schoolgirl',
      'schoolgirls',
      'schoolboy',
      'schoolboys',
      'girl',
      'girls',
      'boy',
      'boys',
      'daughter',
      'daughters',
      'niece',
      'nephew',
      'stepdaughter',
      'stepson',
      'stepchild',
      'stepchildren',
    ],
    sexualTerms: [
      'sexual',
      'sexually',
      'sexualize',
      'sexualized',
      'sexualised',
      'sexualizing',
      'porn',
      'porno',
      'pornographic',
      'pornography',
      'erotic',
      'erotica',
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
    ],
    /** "sex" counts only in these phrases: "sex with", "have sex", "sex scene". */
    sexPhraseNeighbours: {
      before: ['have', 'has', 'had', 'having'],
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
    },
    windowTokens: 8,
  },
} as const;

export interface HardFloorResult {
  blocked: boolean;
  rule?: string;
  version: string;
}

const CONFUSABLE: Readonly<Record<string, string>> = {
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
};

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
};
const AGE_NUMBER =
  '(\\d{1,2}|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)';
const AGE_PHRASE = new RegExp(
  `\\b${AGE_NUMBER}(?:[\\s-]*(?:yo|y\\/o|y\\.o\\.?|(?:years?|yrs?)[\\s-]*old))\\b|\\b(?:age|aged)[\\s:]*${AGE_NUMBER}\\b`,
  'g',
);
const UNDER_EIGHTEEN = /\bunder[\s-]*(?:18|eighteen)\b/g;

const termPattern = (term: string) =>
  new RegExp(`^${[...term].map((c) => `${c}+`).join('')}$`, 'u');
const matcher = (terms: readonly string[]) => {
  const patterns = terms.map(termPattern);
  return (token: string) => patterns.some((p) => p.test(token));
};

const EXPLICIT = matcher(HARD_FLOOR_RULES['csam.explicit-term'].terms);
const PROXIMITY = HARD_FLOOR_RULES['minor-sexual.proximity'];
const MINOR = matcher(PROXIMITY.minorTerms);
const SEXUAL = matcher(PROXIMITY.sexualTerms);
const SEX = termPattern('sex');
const isBefore = matcher(PROXIMITY.sexPhraseNeighbours.before);
const isAfter = matcher(PROXIMITY.sexPhraseNeighbours.after);

const ageValue = (raw: string) =>
  /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];

function normalizeText(input: string): string {
  let s = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\p{Cf}+/gu, '')
    .toLowerCase();
  s = [...s].map((c) => CONFUSABLE[c] ?? c).join('');
  s = s.replace(/@/g, 'a').replace(/\$/g, 's');
  s = s.replace(
    AGE_PHRASE,
    (match, a: string | undefined, b: string | undefined) => {
      const value = ageValue(a ?? b ?? '');
      return value !== undefined && value < 18 ? ' minorage ' : match;
    },
  );
  return s.replace(UNDER_EIGHTEEN, ' minorage ');
}

const leet = (word: string) =>
  /\p{L}/u.test(word) ? word.replace(/[0134578]/g, (d) => LEET[d]!) : word;

/** Words split on punctuation; runs of single letters ("c.h.i.l.d") join into one token. `null` marks a sentence break. */
function tokenize(text: string): (string | null)[] {
  const items = [...text.matchAll(/([\p{L}\p{N}]+)([^\p{L}\p{N}]*)/gu)];
  const words = items.map((m) => leet(m[1]!));
  const out: (string | null)[] = [];
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    let sep = items[i]![2]!;
    const single = (w: string) => w.length === 1 && /\p{L}/u.test(w);
    if (single(word)) {
      while (i + 1 < words.length && single(words[i + 1]!)) {
        i++;
        word += words[i];
        sep = items[i]![2]!;
      }
    }
    out.push(word);
    if (/[.!?;\n]/.test(sep)) out.push(null);
  }
  return out;
}

function sexualAt(tokens: string[], i: number): boolean {
  const t = tokens[i]!;
  if (SEXUAL(t)) return true;
  if (!SEX.test(t)) return false;
  return (
    (i > 0 && isBefore(tokens[i - 1]!)) ||
    (i + 1 < tokens.length && isAfter(tokens[i + 1]!))
  );
}

function minorAt(tokens: string[], i: number): boolean {
  const t = tokens[i]!;
  return MINOR(t) || (t === 'age' && i > 0 && tokens[i - 1] === 'under');
}

function sentenceHasMinorNearSexual(tokens: string[]): boolean {
  const minors: number[] = [];
  const sexual: number[] = [];
  tokens.forEach((_, i) => {
    if (minorAt(tokens, i)) minors.push(i);
    if (sexualAt(tokens, i)) sexual.push(i);
  });
  return minors.some((m) =>
    sexual.some((s) => Math.abs(m - s) <= PROXIMITY.windowTokens),
  );
}

export function checkHardFloor(text: string): HardFloorResult {
  const tokens = tokenize(normalizeText(text));
  const blocked = (rule: string): HardFloorResult => ({
    blocked: true,
    rule,
    version: HARD_FLOOR_VERSION,
  });
  if (tokens.some((t) => t !== null && EXPLICIT(t)))
    return blocked('csam.explicit-term');
  let sentence: string[] = [];
  for (const t of [...tokens, null]) {
    if (t !== null) {
      sentence.push(t);
      continue;
    }
    if (sentenceHasMinorNearSexual(sentence))
      return blocked('minor-sexual.proximity');
    sentence = [];
  }
  return { blocked: false, version: HARD_FLOOR_VERSION };
}
