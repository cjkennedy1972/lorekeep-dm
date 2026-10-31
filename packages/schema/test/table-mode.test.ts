import { describe, expect, test } from 'vitest';
import { ClientRoomStateSchema } from '../src/index.js';

const base = {
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  phase: 'lobby',
  seats: [],
};

describe('client room snapshot tableMode', () => {
  test('accepts solo and party', () => {
    expect(
      ClientRoomStateSchema.parse({ ...base, tableMode: 'solo' }).tableMode,
    ).toBe('solo');
    expect(
      ClientRoomStateSchema.parse({ ...base, tableMode: 'party' }).tableMode,
    ).toBe('party');
  });

  test('is optional, so an older server snapshot still parses', () => {
    expect(ClientRoomStateSchema.parse(base).tableMode).toBeUndefined();
  });

  test('rejects any other mode', () => {
    expect(() =>
      ClientRoomStateSchema.parse({ ...base, tableMode: 'spectate' }),
    ).toThrow();
  });
});
