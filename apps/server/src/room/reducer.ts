import { RoomStateSchema, type RoomState, type Seat } from '@game/schema';
import type { StoredEvent } from '../persistence/index.js';

export function emptyRoom(sessionId: string): RoomState {
  return RoomStateSchema.parse({ sessionId, phase: 'lobby', seats: [] });
}

export function reduceRoom(state: RoomState, event: StoredEvent): RoomState {
  if (event.type === 'RoundOpened') {
    const closedRoundSubmissions = [
      ...(state.closedRoundSubmissions ?? []),
      ...(state.round?.submissions ?? []).map((submission) => ({
        accountId: submission.accountId,
        actionIds: submission.actionIds,
      })),
    ].slice(-120);
    return RoomStateSchema.parse({
      ...state,
      round: event.payload,
      closedRoundSubmissions,
    });
  }
  if (event.type === 'RoundActionAccepted') {
    const round = state.round;
    if (!round) return state;
    const { submission, queued } = event.payload as {
      submission: NonNullable<RoomState['round']>['submissions'][number];
      queued: boolean;
    };
    const list = queued ? round.queuedSubmissions : round.submissions;
    if (list.some((item) => item.seatId === submission.seatId)) return state;
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...round,
        [queued ? 'queuedSubmissions' : 'submissions']: [...list, submission],
      },
    });
  }
  if (event.type === 'RoundActionEdited') {
    const round = state.round;
    if (!round) return state;
    const { submission } = event.payload as {
      submission: NonNullable<RoomState['round']>['submissions'][number];
    };
    const replace = (items: typeof round.submissions) =>
      items.map((item) =>
        item.seatId === submission.seatId ? submission : item,
      );
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...round,
        submissions: replace(round.submissions),
        queuedSubmissions: replace(round.queuedSubmissions),
      },
    });
  }
  if (event.type === 'RoundActionWithdrawn') {
    const round = state.round;
    if (!round) return state;
    const { seatId } = event.payload as { seatId: string };
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...round,
        submissions: round.submissions.filter((item) => item.seatId !== seatId),
        queuedSubmissions: round.queuedSubmissions.filter(
          (item) => item.seatId !== seatId,
        ),
      },
    });
  }
  if (event.type === 'RoundClosing') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...state.round,
        status: 'closing',
        closeReason: (
          event.payload as {
            closeReason: 'all-submitted' | 'timer' | 'resolve-now';
          }
        ).closeReason,
      },
    });
  }
  if (event.type === 'RoundResolved') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: { ...state.round, status: 'resolving' },
    });
  }
  if (event.type === 'RoundCompleted') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: { ...state.round, status: 'resolved' },
    });
  }
  if (event.type === 'RoundTimerPaused') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...state.round,
        deadlineAt: null,
        remainingMs: (event.payload as { remainingMs: number }).remainingMs,
      },
    });
  }
  if (event.type === 'RoundTimerResumed') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...state.round,
        deadlineAt: (event.payload as { deadlineAt: number }).deadlineAt,
        remainingMs: undefined,
      },
    });
  }
  if (event.type === 'RoundTimerConfigured') {
    return RoomStateSchema.parse({
      ...state,
      roundDurationMs: (event.payload as { durationMs: number | null })
        .durationMs,
    });
  }
  if (event.type === 'SeatJoined') {
    const seat = event.payload as Seat;
    if (state.seats.some((item) => item.accountId === seat.accountId))
      return state;
    return RoomStateSchema.parse({ ...state, seats: [...state.seats, seat] });
  }
  if (event.type === 'SeatRevoked') {
    const { seatId } = event.payload as { seatId: string };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.filter((seat) => seat.seatId !== seatId),
    });
  }
  if (event.type === 'GameStateCommitted') {
    const payload = event.payload as { gameState: unknown };
    return RoomStateSchema.parse({ ...state, gameState: payload.gameState });
  }
  if (event.type === 'SafetyFlag') {
    const xCard = state.xCard ?? { requested: 0, steered: 0 };
    return RoomStateSchema.parse({
      ...state,
      xCard: { ...xCard, requested: xCard.requested + 1 },
    });
  }
  if (event.type === 'ClarificationClosed') {
    const { actionId } = event.payload as { actionId: string };
    const openClarifications = { ...state.openClarifications };
    delete openClarifications[actionId];
    return RoomStateSchema.parse({ ...state, openClarifications });
  }
  if (event.type === 'TablePaused') {
    const { paused } = event.payload as { paused: boolean };
    return RoomStateSchema.parse({ ...state, paused });
  }
  if (event.type === 'PresenceChanged') {
    const payload = event.payload as {
      seatId: string;
      presence: Seat['presence'];
    };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) =>
        seat.seatId === payload.seatId
          ? { ...seat, presence: payload.presence }
          : seat,
      ),
    });
  }
  return state;
}
