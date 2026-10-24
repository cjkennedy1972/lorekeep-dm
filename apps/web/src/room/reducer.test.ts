import { describe, expect, test } from 'vitest';
import {
  SeatIdSchema,
  SessionIdSchema,
  AccountIdSchema,
  type RoomState,
  type RoundSnapshot,
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
      matureOptOut: false,
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
const actionId = '00000000-0000-4000-8000-0000000000e1';
const round: RoundSnapshot = {
  roundId: '00000000-0000-4000-8000-0000000000d1',
  status: 'open',
  eligibleSeatIds: [seatId],
  deadlineAt: null,
  submissions: [
    {
      seatId,
      actionId,
      originalActionId: actionId,
      actionIds: [actionId],
      playerName: 'Sam',
      receiptSeq: 1,
    },
  ],
  queuedSubmissions: [],
};
const syncWithRound = (
  seq: number,
  snapshot?: RoundSnapshot,
): ServerMessage => ({
  seq,
  type: 'StateSync',
  payload: snapshot ? { state, round: snapshot } : { state },
});

describe('roomReducer bound seats', () => {
  const bound = (seq: number, id = seatId): ServerMessage =>
    ({
      seq,
      type: 'SeatCharacterBound',
      payload: { seatId: id },
    }) as ServerMessage;
  const released = (seq: number): ServerMessage =>
    ({
      seq,
      type: 'SeatCharacterReleased',
      payload: { seatId, reason: 'removed' },
    }) as ServerMessage;
  const live = roomReducer(initialRoomView, sync(1));

  test('starts with no bound seats', () => {
    expect(initialRoomView.boundSeatIds).toEqual([]);
  });

  test('a sequenced bind adds the seat and a release removes it', () => {
    const boundView = roomReducer(live, bound(2));
    expect(boundView.boundSeatIds).toEqual([seatId]);
    expect(boundView.lastSeq).toBe(2);
    const releasedView = roomReducer(boundView, released(3));
    expect(releasedView.boundSeatIds).toEqual([]);
  });

  test('a repeated bind does not duplicate the seat', () => {
    const once = roomReducer(live, bound(2));
    const twice = roomReducer(once, bound(3));
    expect(twice.boundSeatIds).toEqual([seatId]);
  });

  test('a bind that skips a sequence number requests resync and leaves the set unchanged', () => {
    const gap = roomReducer(live, bound(5));
    expect(gap.needsResync).toBe(true);
    expect(gap.boundSeatIds).toEqual([]);
  });

  test('StateSync keeps the bound set it already tracked', () => {
    const boundView = roomReducer(live, bound(2));
    const resynced = roomReducer(boundView, sync(3));
    expect(resynced.boundSeatIds).toEqual([seatId]);
  });
});

describe('roomReducer', () => {
  test('private round sync restores only the current seat draft and omission clears it', () => {
    const synced = roomReducer(initialRoomView, {
      seq: 3,
      type: 'SeatPrivateRoundSync',
      payload: {
        roundId: round.roundId,
        submission: { actionId, text: 'my draft', queued: true },
      },
    });
    expect(synced.privateRoundSubmission).toEqual({
      roundId: round.roundId,
      actionId,
      text: 'my draft',
      queued: true,
    });
    const cleared = roomReducer(synced, {
      seq: 4,
      type: 'SeatPrivateRoundSync',
      payload: { roundId: round.roundId },
    });
    expect(cleared.privateRoundSubmission).toBeUndefined();
  });
  test('resolved round clears its private draft', () => {
    const synced = roomReducer(initialRoomView, {
      seq: 3,
      type: 'SeatPrivateRoundSync',
      payload: {
        roundId: round.roundId,
        submission: { actionId, text: 'my draft', queued: false },
      },
    });
    const resolved = roomReducer(synced, {
      seq: 4,
      type: 'RoundResolved',
      payload: { roundId: round.roundId, actions: [] },
    });
    expect(resolved.privateRoundSubmission).toBeUndefined();
    expect(resolved.needsResync).toBe(true);
  });

  test('close, queue, and resync preserve the queued public and private action', () => {
    const queuedActionId = '00000000-0000-4000-8000-0000000000e2';
    const queuedRound: RoundSnapshot = {
      ...round,
      status: 'closing',
      queuedSubmissions: [
        {
          seatId,
          actionId: queuedActionId,
          originalActionId: queuedActionId,
          actionIds: [queuedActionId],
          playerName: 'Sam',
          receiptSeq: 2,
        },
      ],
    };
    let view = roomReducer(initialRoomView, syncWithRound(10, round));
    view = roomReducer(view, {
      seq: 11,
      type: 'RoundClosing',
      payload: { roundId: round.roundId, closeReason: 'timer' },
    } as unknown as ServerMessage);
    view = roomReducer(view, {
      seq: 12,
      type: 'RoundResolved',
      payload: { roundId: round.roundId, closeReason: 'timer', actions: [] },
    } as unknown as ServerMessage);
    view = roomReducer(view, syncWithRound(12, queuedRound));
    view = roomReducer(view, {
      seq: 13,
      type: 'RoundActionQueued',
      payload: { roundId: round.roundId, seatId, actionId: queuedActionId },
    } as unknown as ServerMessage);
    view = roomReducer(view, {
      seq: 13,
      type: 'SeatPrivateRoundSync',
      payload: {
        roundId: round.roundId,
        submission: {
          actionId: queuedActionId,
          text: 'A late thought.',
          queued: true,
        },
      },
    });
    view = roomReducer(view, syncWithRound(13, queuedRound));

    expect(view.room?.round?.queuedSubmissions).toMatchObject([
      { actionId: queuedActionId },
    ]);
    expect(view.privateRoundSubmission).toMatchObject({
      actionId: queuedActionId,
      text: 'A late thought.',
      queued: true,
    });
    expect(view.roundCloseAnnouncement).toEqual({
      roundId: round.roundId,
      closeReason: 'timer',
      summary: '1 of 1 submitted.',
    });
    expect(view.lastSeq).toBe(13);
    expect(view.needsResync).toBe(false);
  });

  test('StateSync replaces state', () => {
    const v = roomReducer(initialRoomView, sync(3));
    expect(v).toMatchObject({ room: state, lastSeq: 3, needsResync: false });
  });
  test('keeps the last close fact across the next RoundOpened event', () => {
    let view = roomReducer(initialRoomView, syncWithRound(10, round));
    view = roomReducer(view, {
      seq: 11,
      type: 'RoundClosing',
      payload: { roundId: round.roundId, closeReason: 'resolve-now' },
    } as unknown as ServerMessage);
    view = roomReducer(view, {
      seq: 12,
      type: 'RoundClosedEmpty',
      payload: { roundId: round.roundId },
    } as unknown as ServerMessage);
    view = roomReducer(view, {
      seq: 13,
      type: 'RoundOpened',
      payload: { roundId: 'next-round' },
    } as unknown as ServerMessage);

    expect(view.roundCloseAnnouncement).toEqual({
      roundId: round.roundId,
      closeReason: 'resolve-now',
      summary: '1 of 1 submitted.',
    });
  });
  test('StateSync stores the public round snapshot', () => {
    const v = roomReducer(initialRoomView, syncWithRound(3, round));
    expect(v.room?.round).toEqual(round);
  });
  test('StateSync without a round clears the stored round', () => {
    const open = roomReducer(initialRoomView, syncWithRound(3, round));
    expect(roomReducer(open, syncWithRound(4)).room?.round).toBeUndefined();
  });
  test('presence patch keeps the stored round', () => {
    const v = roomReducer(
      roomReducer(initialRoomView, syncWithRound(3, round)),
      pres(4, 'away'),
    );
    expect(v.room?.round).toEqual(round);
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
  test('StateSync at the stored seq clears a pending resync', () => {
    const thin = roomReducer(roomReducer(initialRoomView, sync(3)), {
      seq: 4,
      type: 'RoundOpened',
      payload: {},
    } as unknown as ServerMessage);
    expect(thin.needsResync).toBe(true);
    const v = roomReducer(thin, syncWithRound(4, round));
    expect(v.needsResync).toBe(false);
    expect(v.room?.round).toEqual(round);
  });
  test('stale StateSync below the stored seq is ignored while resync is pending', () => {
    const thin = roomReducer(roomReducer(initialRoomView, sync(5)), {
      seq: 6,
      type: 'RoundOpened',
      payload: {},
    } as unknown as ServerMessage);
    expect(thin.needsResync).toBe(true);
    const v = roomReducer(thin, syncWithRound(5, round));
    expect(v).toBe(thin);
    expect(v.lastSeq).toBe(6);
    expect(v.needsResync).toBe(true);
    expect(v.room?.round).toBeUndefined();
  });
  test('StateSync at the stored seq keeps the round when it clears a pending resync', () => {
    const thin = roomReducer(roomReducer(initialRoomView, sync(5)), {
      seq: 6,
      type: 'RoundOpened',
      payload: {},
    } as unknown as ServerMessage);
    const v = roomReducer(thin, syncWithRound(6, round));
    expect(v.needsResync).toBe(false);
    expect(v.lastSeq).toBe(6);
    expect(v.room?.round).toEqual(round);
  });
  test('higher-seq StateSync applies while resync is pending', () => {
    const thin = roomReducer(roomReducer(initialRoomView, sync(5)), {
      seq: 6,
      type: 'RoundOpened',
      payload: {},
    } as unknown as ServerMessage);
    const v = roomReducer(thin, syncWithRound(8, round));
    expect(v.needsResync).toBe(false);
    expect(v.lastSeq).toBe(8);
    expect(v.room?.round).toEqual(round);
  });
  test('patch before any StateSync requests resync', () => {
    expect(roomReducer(initialRoomView, pres(1, 'away')).needsResync).toBe(
      true,
    );
  });
});
