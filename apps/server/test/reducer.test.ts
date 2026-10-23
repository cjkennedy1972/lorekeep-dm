import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reduceRoom, emptyRoom } from '../src/room/reducer.js';
import type { StoredEvent } from '../src/persistence/index.js';
import type { RoomState } from '@game/schema';

const sessionId = randomUUID();
const seatId = randomUUID();
const accountId = randomUUID();
const action = (actionId: string, text: string) => ({
  seatId,
  accountId,
  actionId,
  originalActionId: actionId,
  actionIds: [actionId],
  text,
  playerName: 'Player',
  receiptSeq: 1,
});
function resolvingState(): RoomState {
  return {
    ...emptyRoom(sessionId),
    round: {
      roundId: randomUUID(),
      status: 'resolving',
      eligibleSeatIds: [seatId],
      deadlineAt: null,
      submissions: [action('00000000-0000-4000-8000-000000000001', 'frozen')],
      queuedSubmissions: [
        action('00000000-0000-4000-8000-000000000002', 'queued'),
      ],
    },
  };
}
function stored(type: string, payload: unknown): StoredEvent {
  return {
    sessionId,
    seq: 1,
    turnId: randomUUID(),
    type,
    payload,
    ts: new Date(),
  };
}

describe('Room event replay', () => {
  it('withdraws a queued action without removing the frozen submission', () => {
    const state = resolvingState();
    const next = reduceRoom(
      state,
      stored('RoundActionWithdrawn', { seatId, queued: true }),
    );
    expect(next.round?.submissions).toEqual(state.round?.submissions);
    expect(next.round?.queuedSubmissions).toEqual([]);
  });

  it('edits a queued action without replacing the frozen submission', () => {
    const state = resolvingState();
    const edited = {
      ...action('00000000-0000-4000-8000-000000000003', 'edited queued'),
      originalActionId: '00000000-0000-4000-8000-000000000002',
      actionIds: [
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ],
    };
    const next = reduceRoom(
      state,
      stored('RoundActionEdited', { submission: edited, queued: true }),
    );
    expect(next.round?.submissions).toEqual(state.round?.submissions);
    expect(next.round?.queuedSubmissions).toEqual([edited]);
  });
});
