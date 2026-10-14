import { describe, expect, it } from 'vitest';
import {
  assertDenylistWellFormed,
  denylist,
  findDenylistedTerms,
} from '../src/adventure/denylist.js';

describe('denylist matching', () => {
  it('matches the term regardless of case and surrounding punctuation', () => {
    expect(findDenylistedTerms('Journey to WATERDEEP!')).toEqual(['Waterdeep']);
  });

  it('matches plural and possessive forms of a term', () => {
    expect(findDenylistedTerms('Drows attack')).toEqual(['Drow']);
    expect(findDenylistedTerms('Beholders float')).toEqual(['Beholder']);
    expect(findDenylistedTerms('Illithids whisper')).toEqual(['Illithid']);
    expect(findDenylistedTerms('Vecnas laughs')).toEqual(['Vecna']);
    expect(findDenylistedTerms("Strahd's castle")).toEqual(['Strahd']);
    expect(findDenylistedTerms('Strahds castle')).toEqual(['Strahd']);
  });

  it('stays whole-word: longer words that embed a term do not match', () => {
    expect(findDenylistedTerms('Drowsy and drowning')).toEqual([]);
    expect(findDenylistedTerms('the baby dragon sleeps')).toEqual([]);
  });

  it('treats runs of spaces, newlines and NBSP as one space in multi-word terms', () => {
    expect(findDenylistedTerms('Forgotten  Realms')).toEqual([
      'Forgotten Realms',
    ]);
    expect(findDenylistedTerms('Forgotten\nRealms')).toEqual([
      'Forgotten Realms',
    ]);
    expect(findDenylistedTerms('Forgotten Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('folds curly apostrophes to the ASCII form of multi-word terms', () => {
    expect(findDenylistedTerms('Baldur’s Gate')).toEqual(["Baldur's Gate"]);
    expect(findDenylistedTerms('Baldurʼs Gate')).toEqual(["Baldur's Gate"]);
  });

  it('applies NFKC so fullwidth letters and long-s match', () => {
    expect(findDenylistedTerms('ＤＲＯＷ')).toEqual(['Drow']);
    expect(findDenylistedTerms('ſtrahd')).toEqual(['Strahd']);
  });

  it('ignores zero-width characters inside a term', () => {
    expect(findDenylistedTerms('Dro​w')).toEqual(['Drow']);
    expect(findDenylistedTerms('Water⁠deep')).toEqual(['Waterdeep']);
  });
});

describe('denylist bypass resistance', () => {
  it('ignores format characters inside a multi-word term', () => {
    expect(findDenylistedTerms('Forgotten​Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('ignores soft hyphens inside a term', () => {
    expect(findDenylistedTerms('Dri­zzt')).toEqual(['Drizzt']);
  });

  it('ignores combining marks inside a term', () => {
    expect(findDenylistedTerms('D́rizzt')).toEqual(['Drizzt']);
  });

  it('ignores variation selectors inside a term', () => {
    expect(findDenylistedTerms('Dri️zzt')).toEqual(['Drizzt']);
  });

  it('folds a Cyrillic i lookalike', () => {
    expect(findDenylistedTerms('Drіzzt')).toEqual(['Drizzt']);
  });

  it('folds a Cyrillic o lookalike', () => {
    expect(findDenylistedTerms('Drоw')).toEqual(['Drow']);
  });

  it('treats underscores as separators in multi-word terms', () => {
    expect(findDenylistedTerms('Forgotten_Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('accepts -es and -ish suffixes', () => {
    expect(findDenylistedTerms('Drowes near')).toEqual(['Drow']);
    expect(findDenylistedTerms('Drowish mood')).toEqual(['Drow']);
  });
});

describe('denylist well-formedness', () => {
  it('accepts the checked-in list', () => {
    expect(() => assertDenylistWellFormed(denylist)).not.toThrow();
  });

  it('rejects an empty list so the check cannot fail open', () => {
    expect(() => assertDenylistWellFormed([])).toThrow();
  });

  it('rejects empty or non-string terms', () => {
    expect(() => assertDenylistWellFormed(['Drow', ''])).toThrow();
    expect(() => assertDenylistWellFormed(['Drow', '   '])).toThrow();
    expect(() =>
      assertDenylistWellFormed(['Drow', undefined as unknown as string]),
    ).toThrow();
  });
});
