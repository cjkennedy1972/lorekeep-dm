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

const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc\u2032`]/g, "'")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');

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

const patterns = denylist.map((term) => ({
  term,
  pattern: new RegExp(
    `(^|[^\\p{L}\\p{N}])${escape(normalize(term))}(?:'s|s)?($|[^\\p{L}\\p{N}])`,
    'u',
  ),
}));

export function findDenylistedTerms(text: string): string[] {
  const normalized = normalize(text);
  return patterns
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ term }) => term);
}
