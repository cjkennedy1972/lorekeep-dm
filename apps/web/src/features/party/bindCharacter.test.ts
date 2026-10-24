import { describe, expect, test } from 'vitest';
import {
  bindFailureFor,
  bindFailureMessage,
  characterLabel,
} from './bindCharacter';

describe('bindFailureFor', () => {
  test('maps the named server codes to their failure', () => {
    expect(bindFailureFor('NOT_OWNER')).toBe('not-owner');
    expect(bindFailureFor('ALREADY_BOUND')).toBe('already-bound');
    expect(bindFailureFor('STALE_REVISION')).toBe('stale-revision');
  });

  test('falls back to rejected for ACTION_REJECTED and unknown codes', () => {
    expect(bindFailureFor('ACTION_REJECTED')).toBe('rejected');
    expect(bindFailureFor('SOMETHING_NEW')).toBe('rejected');
  });
});

describe('bindFailureMessage', () => {
  test('every failure has a distinct, non-empty sentence', () => {
    const messages = (
      ['not-owner', 'already-bound', 'stale-revision', 'rejected'] as const
    ).map(bindFailureMessage);
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) expect(m.length).toBeGreaterThan(10);
  });

  test('stale revision tells the player to reload', () => {
    expect(bindFailureMessage('stale-revision')).toMatch(/reload/i);
  });
});

describe('characterLabel', () => {
  test('names the character with species, class and level only', () => {
    expect(
      characterLabel({
        id: '00000000-0000-4000-8000-0000000000f1',
        name: 'Aldric Vane',
        species: 'Human',
        className: 'Fighter',
        level: 3,
        revision: 1,
      }),
    ).toBe('Aldric Vane, Human Fighter, level 3');
  });
});
