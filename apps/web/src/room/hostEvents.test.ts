import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@game/schema';
import { initialRoomView, roomReducer } from './reducer';

// Host broadcasts carry a bare type with no payload schema, so the reducer must ask for a
// StateSync rather than guess the new room state from them.
const HOST_EVENTS = [
  'SeatRevoked',
  'HostTransferred',
  'HostSeatChanged',
  'LateJoinRequested',
  'LateJoinDenied',
  'LateJoinApproved',
  'TableEnded',
  'ChatMuteChanged',
] as const;

describe('host broadcast events', () => {
  it.each(HOST_EVENTS)(
    '%s requests a resync and does not advance seq',
    (type) => {
      const next = roomReducer(initialRoomView, {
        seq: 3,
        type,
        payload: {},
      } as unknown as ServerMessage);
      expect(next.needsResync).toBe(true);
      expect(next.lastSeq).toBe(0);
    },
  );
});
