import { describe, expect, test } from 'vitest';
import { ContentTierSchema, EngineEventSchema } from '../src/events.js';
import { RoomStateSchema, SeatSchema } from '../src/room.js';

const changed = {
  type: 'ContentTierChanged' as const,
  from: 'mature' as const,
  to: 'standard' as const,
};

describe('ContentTierChanged', () => {
  test('serializes and parses back unchanged', () => {
    const wire = JSON.parse(JSON.stringify(changed));
    expect(EngineEventSchema.parse(wire)).toEqual(changed);
  });

  test('rejects an unknown tier', () => {
    expect(
      EngineEventSchema.safeParse({ ...changed, to: 'explicit' }).success,
    ).toBe(false);
  });

  test('tier enum is exactly family | standard | mature', () => {
    expect(ContentTierSchema.options).toEqual(['family', 'standard', 'mature']);
  });
});

describe('seat matureOptOut', () => {
  const seat = {
    seatId: '7f0c1f7e-6b7a-4c1e-9a55-2b2f2d3a4b5c',
    accountId: '3d1e2f40-1111-4a2b-8c3d-4e5f60718293',
    displayName: 'Ayla',
    presence: 'offline' as const,
  };

  test('legacy SeatJoined payloads without the field parse as opted-in', () => {
    expect(SeatSchema.parse(seat).matureOptOut).toBe(false);
  });

  test('a join-time opt-out is carried on the seat', () => {
    expect(SeatSchema.parse({ ...seat, matureOptOut: true }).matureOptOut).toBe(
      true,
    );
  });

  test('room state keeps the seat opt-out', () => {
    const room = RoomStateSchema.parse({
      sessionId: '0f3b2a10-2222-4b3c-9d4e-5f6071829304',
      phase: 'lobby',
      seats: [{ ...seat, matureOptOut: true }],
    });
    expect(room.seats[0]?.matureOptOut).toBe(true);
  });
});
