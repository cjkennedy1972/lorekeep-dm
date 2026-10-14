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
  it('ignores zero-width format characters inside a multi-word term', () => {
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

  it('treats underscores as separators, so identifiers cannot hide a term', () => {
    expect(findDenylistedTerms('Forgotten_Realms')).toEqual([
      'Forgotten Realms',
    ]);
    expect(findDenylistedTerms('drow_id')).toEqual(['Drow']);
  });

  it('folds apostrophes out of multi-word terms', () => {
    expect(findDenylistedTerms('Baldurs Gate')).toEqual(["Baldur's Gate"]);
    expect(findDenylistedTerms('Dungeon Masters Guide')).toEqual([
      "Dungeon Master's Guide",
    ]);
  });

  it('matches separator punctuation inside a single word', () => {
    expect(findDenylistedTerms('Dr**ow**')).toEqual(['Drow']);
    expect(findDenylistedTerms('Stra*h*d')).toEqual(['Strahd']);
    expect(findDenylistedTerms('Dr`ow')).toEqual(['Drow']);
    expect(findDenylistedTerms('Dr-ow')).toEqual(['Drow']);
  });

  it('folds the added homoglyphs for v, w and i', () => {
    expect(findDenylistedTerms('Ѵecna')).toEqual(['Vecna']);
    expect(findDenylistedTerms('ωaterdeep')).toEqual(['Waterdeep']);
    expect(findDenylistedTerms('Ωaterdeep')).toEqual(['Waterdeep']);
    expect(findDenylistedTerms('ԝaterdeep')).toEqual(['Waterdeep']);
    expect(findDenylistedTerms('Illɪthid')).toEqual(['Illithid']);
  });

  it('does not let a comma bridge two words', () => {
    expect(findDenylistedTerms('Forgotten, Realms')).toEqual([]);
    expect(findDenylistedTerms('Forgotten,Realms')).toEqual([]);
  });

  it('does not let a dot and space bridge two words', () => {
    expect(findDenylistedTerms('Forgotten . Realms')).toEqual([]);
  });

  it('matches a single word spelled out with letters split by + , ; ~ ! #', () => {
    expect(findDenylistedTerms('D+r+o+w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D,r,o,w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D;r;o;w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D~r~o~w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D#r#o#w')).toEqual(['Drow']);
  });

  it('does not treat single letters separated by punctuation in prose as a spelled-out term', () => {
    expect(findDenylistedTerms('a+b, c; d ~ e!f#g')).toEqual([]);
    expect(findDenylistedTerms('I saw d+ etc r; o ~ w!')).toEqual([]);
  });

  it('matches a single word spelled out with letters split by space, dot or bullet', () => {
    expect(findDenylistedTerms('D r o w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D.r.o.w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D•r•o•w')).toEqual(['Drow']);
    expect(findDenylistedTerms('d r o w')).toEqual(['Drow']);
    expect(findDenylistedTerms('Dr o w')).toEqual(['Drow']);
    expect(findDenylistedTerms('D r-o-w')).toEqual(['Drow']);
  });

  it('does not flag ordinary sentences with single-letter words', () => {
    expect(findDenylistedTerms('a I want a dog')).toEqual([]);
  });

  it('matches a term split by an en dash', () => {
    expect(findDenylistedTerms('Forgotten – Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('accepts -es and -ish suffixes', () => {
    expect(findDenylistedTerms('Drowes near')).toEqual(['Drow']);
    expect(findDenylistedTerms('Drowish mood')).toEqual(['Drow']);
  });

  it('strips marks introduced by locale lowercasing of a dotted capital I', () => {
    expect(findDenylistedTerms('DRİZZT')).toEqual(['Drizzt']);
  });

  it('folds a Cyrillic h lookalike in Githyanki', () => {
    expect(findDenylistedTerms('Gitһyanki')).toEqual(['Githyanki']);
  });

  it('folds a Cyrillic h lookalike in Illithid', () => {
    expect(findDenylistedTerms('Illitһid')).toEqual(['Illithid']);
  });

  it('folds a dotless i lookalike in Illithid', () => {
    expect(findDenylistedTerms('Illıthid')).toEqual(['Illithid']);
  });

  it('folds a Cyrillic d lookalike in Drizzt', () => {
    expect(findDenylistedTerms('ԁrizzt')).toEqual(['Drizzt']);
  });

  it('folds a Latin script g lookalike in Baldur’s Gate', () => {
    expect(findDenylistedTerms("Baldur's ɡate")).toEqual(["Baldur's Gate"]);
  });

  it('treats dots as separators in multi-word terms', () => {
    expect(findDenylistedTerms('Forgotten.Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('treats slashes as separators in multi-word terms', () => {
    expect(findDenylistedTerms('Forgotten/Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it('treats asterisks as separators in multi-word terms', () => {
    expect(findDenylistedTerms('Forgotten*Realms')).toEqual([
      'Forgotten Realms',
    ]);
  });

  it.each([
    'Forgotten - Realms',
    'Forgotten -Realms',
    'Forgotten* Realms',
    'Forgotten .Realms',
    'Forgotten *Realms',
    'Forgotten *Realms*',
    '**Forgotten** **Realms**',
  ])('matches the term split by separator punctuation: %s', (text) => {
    expect(findDenylistedTerms(text)).toEqual(['Forgotten Realms']);
  });

  it.each([
    'Forgotten–Realms',
    'Forgotten—Realms',
    'Forgotten‒Realms',
    'Forgotten−Realms',
    'Forgotten:Realms',
    'Forgotten|Realms',
    'Forgotten·Realms',
    'Forgotten…Realms',
    'Forgotten&Realms',
  ])('matches the term split by dashes and other punctuation: %s', (text) => {
    expect(findDenylistedTerms(text)).toEqual(['Forgotten Realms']);
  });

  it('does not let a dot followed by a space bridge two words', () => {
    expect(findDenylistedTerms('forgotten. Realms')).toEqual([]);
    expect(
      findDenylistedTerms('The memory was forgotten. Realms beyond'),
    ).toEqual([]);
  });

  it('matches a precomposed accented letter inside a term', () => {
    expect(findDenylistedTerms('Stráhd')).toEqual(['Strahd']);
  });

  it('matches a decomposed accented letter inside a term', () => {
    expect(findDenylistedTerms('Stráhd')).toEqual(['Strahd']);
  });

  it('folds a Latin alpha lookalike', () => {
    expect(findDenylistedTerms('Vecnɑ')).toEqual(['Vecna']);
  });

  it('folds a Latin iota lookalike', () => {
    expect(findDenylistedTerms('Illɩthid')).toEqual(['Illithid']);
  });

  it('folds an Armenian oh lookalike', () => {
    expect(findDenylistedTerms('Drօw')).toEqual(['Drow']);
  });

  it('folds an Armenian vo lookalike', () => {
    expect(findDenylistedTerms('Vecոa')).toEqual(['Vecna']);
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
