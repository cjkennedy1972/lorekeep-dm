import { describe, expect, test } from 'vitest';
import { SeatIdSchema } from '@game/schema';
import { loadCharacterCatalog } from '../character/catalog';
import {
  bindFailureFor,
  bindFailureMessage,
  canOfferPicker,
  characterLabel,
  type BindFailure,
} from './bindCharacter';

const catalog = loadCharacterCatalog();

describe('bindFailureFor', () => {
  test('maps every named server code to its failure', () => {
    expect(bindFailureFor('NOT_OWNER')).toBe('not-owner');
    expect(bindFailureFor('ALREADY_BOUND')).toBe('already-bound');
    expect(bindFailureFor('STALE_REVISION')).toBe('stale-revision');
    expect(bindFailureFor('NOT_SEATED')).toBe('not-seated');
    expect(bindFailureFor('ACCOUNT_INACTIVE')).toBe('account-inactive');
    expect(bindFailureFor('RATE_LIMITED')).toBe('rate-limited');
  });

  test('falls back to rejected for ACTION_REJECTED and unknown codes', () => {
    expect(bindFailureFor('ACTION_REJECTED')).toBe('rejected');
    expect(bindFailureFor('SOMETHING_NEW')).toBe('rejected');
  });
});

describe('bindFailureMessage', () => {
  test('every failure has a distinct, non-empty sentence', () => {
    const all: BindFailure[] = [
      'not-owner',
      'already-bound',
      'stale-revision',
      'not-seated',
      'account-inactive',
      'rate-limited',
      'rejected',
      'no-reply',
      'interrupted',
    ];
    const messages = all.map(bindFailureMessage);
    expect(new Set(messages).size).toBe(all.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(10);
  });

  test('stale revision tells the player to reload', () => {
    expect(bindFailureMessage('stale-revision')).toMatch(/reload/i);
  });

  test('rate limiting reads differently from a rejected bind', () => {
    expect(bindFailureMessage('rate-limited')).toMatch(/too many/i);
    expect(bindFailureMessage('rate-limited')).not.toBe(
      bindFailureMessage('rejected'),
    );
  });
});

describe('characterLabel', () => {
  const owned = {
    id: '00000000-0000-4000-8000-0000000000f1',
    name: 'Aldric Vane',
    classId: 'class:fighter',
    speciesId: 'species:human',
    level: 3,
    revision: 1,
  };

  test('names the character with catalog species, class and level only', () => {
    const label = characterLabel(owned, catalog);
    expect(label.startsWith('Aldric Vane, ')).toBe(true);
    expect(label).toMatch(/level 3$/);
    expect(label).toContain(catalog.getAny('class:fighter')?.name);
    expect(label).toContain(catalog.getAny('species:human')?.name);
  });

  test('falls back to the raw id when the catalog lacks it', () => {
    expect(
      characterLabel({ ...owned, classId: 'class:unknown' }, catalog),
    ).toBe('Aldric Vane, Human class:unknown, level 3');
  });
});

describe('canOfferPicker', () => {
  const SEAT_A = '00000000-0000-4000-8000-0000000000a1';
  const SEAT_B = '00000000-0000-4000-8000-0000000000a2';
  const SEAT_Z = '00000000-0000-4000-8000-0000000000a3';
  const seats = [
    { seatId: SeatIdSchema.parse(SEAT_A), presence: 'online' as const },
    { seatId: SeatIdSchema.parse(SEAT_B), presence: 'revoked' as const },
  ];

  test('is offered while the local seat is active and current', () => {
    expect(canOfferPicker(seats, SEAT_A, false)).toBe(true);
  });

  test('is hidden when the local seat is revoked', () => {
    expect(canOfferPicker(seats, SEAT_B, false)).toBe(false);
  });

  test('is hidden when the seat is unseated', () => {
    expect(canOfferPicker(seats, SEAT_A, true)).toBe(false);
  });

  test('is hidden when there is no local seat', () => {
    expect(canOfferPicker(seats, null, false)).toBe(false);
  });

  test('is hidden when the local seat is missing from the table', () => {
    expect(canOfferPicker(seats, SEAT_Z, false)).toBe(false);
  });
});
