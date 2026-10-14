export const denylist = [
  'Acererak',
  "Baldur's Gate",
  'Beholder',
  'Drizzt',
  'Drow',
  "Dungeon Master's Guide",
  'Forgotten Realms',
  'Githyanki',
  'Illithid',
  'Mordenkainen',
  'Ravenloft',
  'Strahd',
  'Vecna',
  'Waterdeep',
] as const;

const confusables: Record<string, string> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  '\u03bf': 'o',
  '\u03b1': 'a',
  '\u03b9': 'i',
  '\u03bd': 'v',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03ba': 'k',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u051d': 'w',
  '\u0475': 'v',
  '\u03c9': 'w',
  '\u0261': 'g',
  '\u0131': 'i',
  '\u0251': 'a',
  '\u0269': 'i',
  '\u026a': 'i',
  '\u0585': 'o',
  '\u0578': 'n',
};

const normalize = (text: string): string =>
  text
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{Cf}\p{M}]/gu, '')
    .replace(/[\u2018\u2019\u02bc\u2032`]/g, "'")
    .replace(/./gu, (char) => confusables[char] ?? char)
    .replace(/\s+/gu, ' ');

export function assertDenylistWellFormed(terms: readonly unknown[]): void {
  if (terms.length === 0) throw new Error('denylist is empty');
  for (const term of terms)
    if (typeof term !== 'string' || normalize(term).trim() === '')
      throw new Error(
        `denylist term is not a non-empty string: ${String(term)}`,
      );
}

assertDenylistWellFormed(denylist);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const separatorPunctuation = "'*/\\-\\u2010-\\u2015\\u2212:|\\u00b7\\u2026&";
const boundary = '[^\\p{L}\\p{N}_]';
const letterGap = `[${separatorPunctuation}]*`;
const wordGap = `[\\s${separatorPunctuation}]*(?:\\.+[${separatorPunctuation}]*)?`;

const patterns = denylist.map((term) => ({
  term,
  pattern: new RegExp(
    `(^|${boundary})${normalize(term)
      .replace(/'/g, '')
      .split(' ')
      .map((word) => Array.from(word, escape).join(letterGap))
      .join(wordGap)}(?:'s|es|ish|s)?($|${boundary})`,
    'u',
  ),
}));

export function findDenylistedTerms(text: string): string[] {
  const normalized = normalize(text);
  return patterns
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ term }) => term);
}
