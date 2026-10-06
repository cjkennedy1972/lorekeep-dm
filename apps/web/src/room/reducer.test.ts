import { describe, expect, test } from 'vitest';
import {
  SeatIdSchema,
  SessionIdSchema,
  AccountIdSchema,
  type RoomState,
  type ServerMessage,
} from '@game/schema';
import { initialRoomView, roomReducer } from './reducer.js';

const seatId = SeatIdSchema.parse('00000000-0000-4000-8000-0000000000b1');
const state: RoomState = {
  sessionId: SessionIdSchema.parse('00000000-0000-4000-8000-0000000000c1'),
  phase: 'lobby',
  seats: [
    {
      seatId,
      accountId: AccountIdSchema.parse('00000000-0000-4000-8000-0000000000a1'),
      displayName: 'Sam',
      presence: 'online',
    },
  ],
};
const sync = (seq: number): ServerMessage => ({
  seq,
  type: 'StateSync',
  payload: { state },
});
const pres = (seq: number, presence: 'away' | 'online'): ServerMessage => ({
  seq,
  type: 'PresenceChanged',
  payload: { seatId, presence },
});

describe('roomReducer', () => {
  test('StateSync replaces state', () => {
    const v = roomReducer(initialRoomView, sync(3));
    expect(v).toEqual({ room: state, lastSeq: 3, needsResync: false });
  });
  test('applies in-order presence patch', () => {
    const v = roomReducer(
      roomReducer(initialRoomView, sync(3)),
      pres(4, 'away'),
    );
    expect(v.room?.seats[0]?.presence).toBe('away');
    expect(v.lastSeq).toBe(4);
  });
  test('duplicate and out-of-order seq are ignored', () => {
    const a = roomReducer(
      roomReducer(initialRoomView, sync(3)),
      pres(4, 'away'),
    );
    expect(roomReducer(a, pres(4, 'online'))).toBe(a);
    expect(roomReducer(a, pres(2, 'online'))).toBe(a);
  });
  test('gap flags resync without applying', () => {
    const a = roomReducer(initialRoomView, sync(3));
    const v = roomReducer(a, pres(6, 'away'));
    expect(v.needsResync).toBe(true);
    expect(v.lastSeq).toBe(3);
    expect(v.room?.seats[0]?.presence).toBe('online');
    expect(roomReducer(v, sync(7)).needsResync).toBe(false);
  });
  test('patch before any StateSync requests resync', () => {
    expect(roomReducer(initialRoomView, pres(1, 'away')).needsResync).toBe(
      true,
    );
  });
});
