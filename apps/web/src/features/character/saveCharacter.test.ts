import { describe, expect, test } from 'vitest';
import type { Character } from '@game/schema';
import {
  createCharacterBody,
  saveFailureFor,
  saveFailureMessage,
  type SaveFailure,
} from './saveCharacter';

const LOCAL_ID = 'character:fighter';
const character = {
  id: LOCAL_ID,
  name: 'Mira',
  classId: 'class:fighter',
  speciesId: 'species:human',
  backgroundId: 'background:soldier',
  level: 1,
} as unknown as Character;

describe('createCharacterBody', () => {
  test('wraps the sheet in a single character key and drops the local id', () => {
    const body = createCharacterBody(character);
    expect(Object.keys(body)).toEqual(['character']);
    expect(body.character).not.toHaveProperty('id');
    expect(body.character).toMatchObject({
      name: 'Mira',
      classId: 'class:fighter',
      level: 1,
    });
  });

  test('preserves the generation and equipment-option evidence for server validation', () => {
    const fullCharacter = {
      ...character,
      abilityGeneration: {
        method: 'standard-array',
        baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      },
      equipmentOption: 'A',
    } as Character;
    expect(createCharacterBody(fullCharacter).character).toMatchObject({
      abilityGeneration: { method: 'standard-array' },
      equipmentOption: 'A',
    });
  });

  test('does not mutate the character it was given', () => {
    createCharacterBody(character);
    expect(character.id).toBe(LOCAL_ID);
  });
});

describe('saveFailureFor', () => {
  test.each([
    ['INVALID_CHARACTER', 'invalid'],
    ['RATE_LIMITED', 'rate-limited'],
    ['ACCOUNT_INACTIVE', 'account-inactive'],
    ['UNAUTHENTICATED', 'unauthenticated'],
  ] as const)('%s maps to %s', (code, failure) => {
    expect(saveFailureFor(code)).toBe(failure);
  });

  test('codes the save does not name, including bad origin and network, are other', () => {
    expect(saveFailureFor('BAD_ORIGIN')).toBe('other');
    expect(saveFailureFor('NETWORK')).toBe('other');
    expect(saveFailureFor('ERROR')).toBe('other');
  });
});

describe('saveFailureMessage', () => {
  const failures: SaveFailure[] = [
    'invalid',
    'rate-limited',
    'account-inactive',
    'unauthenticated',
    'other',
    'uncertain',
  ];

  test('every failure has its own non-empty copy', () => {
    const messages = failures.map(saveFailureMessage);
    expect(messages.every((m) => m.trim().length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(failures.length);
  });

  test('the uncertain copy says the save may have happened and points to the lobby', () => {
    expect(saveFailureMessage('uncertain')).toMatch(
      /may or may not have saved/,
    );
    expect(saveFailureMessage('uncertain')).toMatch(/party lobby/);
  });

  test('the session-ended copy points to signing in', () => {
    expect(saveFailureMessage('unauthenticated')).toMatch(/sign in/i);
  });
});
