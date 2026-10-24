import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seatEntityId, seatIdFromEntityId } from '../../src/room/seatEntity.js';

describe('seat entity ids', () => {
  it('derives a stable ent_seat_<seatUUID> and round-trips', () => {
    const seatId = randomUUID();
    expect(seatEntityId(seatId)).toBe(`ent_seat_${seatId}`);
    expect(seatEntityId(seatId)).toBe(seatEntityId(seatId));
    expect(seatIdFromEntityId(seatEntityId(seatId))).toBe(seatId);
  });

  it('does not parse non-seat entities', () => {
    expect(seatIdFromEntityId('goblin-1')).toBeUndefined();
  });
});
