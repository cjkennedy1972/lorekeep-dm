import { describe, expect, it } from 'vitest';
import { checkHardFloor } from '../../src/safety/hardFloor.js';

/** M3-34 Sentinel finding (High): a name, bare age, then a copula and sexual term was not blocked. */
const MUST_BLOCK: readonly [string, string][] = [
  ['M334 name age copula sexual', 'Mira 12 is sexual.'],
  ['M334 name age copula naked', 'Mira 12 is naked.'],
  ['M334 name age adult-marker and naked', 'Mira 12 is grown and naked.'],
  [
    'M334 name age article adult-marker and naked',
    'Mira 12 is an adult and naked.',
  ],
  ['M334 name age article sexual term', 'Mira 12 is a sexy girl.'],
  [
    'M334 name age relative-clause sexual predicate',
    'Mira 12 is a girl who is naked.',
  ],
  ['M334 name age copula undressed', 'Mira 12 is undressed.'],
  ['M334 name age undresses', 'Mira 12 undresses.'],
  ['M334 name age gets undressed', 'Mira 12 gets undressed.'],
  ['M334 explicit age bed undressing', 'Mira 12 is undressed for bed.'],
  ['M334 name age article undressed', 'Mira 12 is an undressed girl.'],
  ['M334 name age was naked', 'Mira 12 was naked.'],
  ['M334 name age are nude', 'Mira 12 are nude.'],
  ['M334 name age is sexy, lowercase', 'mira 12 is sexy.'],
  ['M334 existing forms still block', 'Mira is 12 and naked.'],
  ['M334 existing parenthesis form', 'Mira (12) is naked.'],
];

const MUST_ALLOW: readonly [string, string][] = [
  ['M334 dice roll then sexy verb', 'Mira rolled a 15 to seduce the guard.'],
  ['M334 count with adult noun', 'Two girls and 9 goblins attack the inn.'],
  ['M334 aged adult guard is tired', 'The guard, aged 12, is tired.'],
  ['M334 undressed for bed without minor age', 'Mira got undressed for bed.'],
];

describe('M3-34 hard-floor copula after bare name age', () => {
  for (const [label, text] of MUST_BLOCK) {
    it(`blocks: ${label}`, () => {
      expect(checkHardFloor(text).blocked).toBe(true);
    });
  }
  for (const [label, text] of MUST_ALLOW) {
    it(`allows: ${label}`, () => {
      expect(checkHardFloor(text).blocked).toBe(false);
    });
  }
});
