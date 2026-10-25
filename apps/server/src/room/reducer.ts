import { RoomStateSchema, type RoomState, type Seat } from '@game/schema';
import type { StoredEvent } from '../persistence/index.js';

export function emptyRoom(sessionId: string): RoomState {
  return RoomStateSchema.parse({ sessionId, phase: 'lobby', seats: [] });
}

export function reduceRoom(state: RoomState, event: StoredEvent): RoomState {
  if (event.type === 'ActionAccepted') {
    const { accountId } = event.payload as { accountId?: string };
    return RoomStateSchema.parse({
      ...state,
      ...(accountId
        ? {
            spotlightActivity: {
              ...(state.spotlightActivity ?? {}),
              [accountId]: state.spotlightTurn ?? 0,
            },
          }
        : {}),
      ...(state.lastRestVoteResult &&
      state.lastRestVoteResultTurnId !== event.turnId
        ? { lastRestVoteResult: undefined, lastRestVoteResultTurnId: undefined }
        : {}),
    });
  }
  if (event.type === 'RestVoteOpened') {
    const payload = event.payload as NonNullable<RoomState['restVote']>;
    return RoomStateSchema.parse({
      ...state,
      restVoteCount: (state.restVoteCount ?? 0) + 1,
      restVote: {
        ...payload,
        ballots: [],
        castSeatIds: [],
      },
    });
  }
  if (event.type === 'RestVoteCast') {
    const vote = state.restVote;
    if (!vote || vote.voteId !== (event.payload as { voteId: string }).voteId)
      return state;
    const payload = event.payload as {
      seat: string;
      choice: 'yes' | 'no';
    };
    const ballots = vote.ballots ?? [];
    if (ballots.length === (vote.eligibleSeats?.length ?? -1))
      return RoomStateSchema.parse({
        ...state,
        restVote: { ...vote, tieBreak: payload.choice },
      });
    if (ballots.some((ballot) => ballot.seat === payload.seat)) return state;
    return RoomStateSchema.parse({
      ...state,
      restVote: {
        ...vote,
        ballots: [...ballots, { seat: payload.seat, choice: payload.choice }],
        castSeatIds: [...(vote.castSeatIds ?? []), payload.seat],
      },
    });
  }
  if (event.type === 'RestVoteCastNotice') {
    const vote = state.restVote;
    const payload = event.payload as { voteId: string; seat: string };
    if (!vote || vote.voteId !== payload.voteId) return state;
    return RoomStateSchema.parse({
      ...state,
      restVote: {
        ...vote,
        castSeatIds: [...new Set([...(vote.castSeatIds ?? []), payload.seat])],
      },
    });
  }
  if (event.type === 'RestVoteClosed') {
    const payload = event.payload as {
      voteId: string;
      outcome: 'passed' | 'failed';
      closeReason: NonNullable<RoomState['lastRestVoteResult']>['closeReason'];
    };
    const vote = state.restVote;
    return RoomStateSchema.parse({
      ...state,
      restVote: undefined,
      restVoteLastClosedAt: event.ts.getTime(),
      ...(vote
        ? {
            lastRestVoteResult: {
              voteId: payload.voteId,
              type: vote.type,
              outcome: payload.outcome,
              closeReason: payload.closeReason,
            },
            lastRestVoteResultTurnId: event.turnId,
          }
        : {}),
    });
  }
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
      spotlightActivity: {
        ...(state.spotlightActivity ?? {}),
        [submission.accountId]: state.spotlightTurn ?? 0,
      },
      round: {
        ...round,
        [queued ? 'queuedSubmissions' : 'submissions']: [...list, submission],
      },
    });
  }
  if (event.type === 'RoundActionEdited') {
    const round = state.round;
    if (!round) return state;
    const { submission, queued } = event.payload as {
      submission: NonNullable<RoomState['round']>['submissions'][number];
      queued: boolean;
    };
    const replace = (items: typeof round.submissions) =>
      items.map((item) =>
        item.seatId === submission.seatId ? submission : item,
      );
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...round,
        submissions: queued ? round.submissions : replace(round.submissions),
        queuedSubmissions: queued
          ? replace(round.queuedSubmissions)
          : round.queuedSubmissions,
      },
    });
  }
  if (event.type === 'RoundActionWithdrawn') {
    const round = state.round;
    if (!round) return state;
    const { seatId, queued, accountId, commandActionId } = event.payload as {
      seatId: string;
      queued: boolean;
      accountId?: string;
      commandActionId?: string;
    };
    return RoomStateSchema.parse({
      ...state,
      round: {
        ...round,
        submissions: queued
          ? round.submissions
          : round.submissions.filter((item) => item.seatId !== seatId),
        queuedSubmissions: queued
          ? round.queuedSubmissions.filter((item) => item.seatId !== seatId)
          : round.queuedSubmissions,
      },
      ...(accountId && commandActionId
        ? {
            closedRoundSubmissions: [
              ...(state.closedRoundSubmissions ?? []),
              { accountId, actionIds: [commandActionId] },
            ].slice(-120),
          }
        : {}),
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
  if (event.type === 'RoundClosedEmpty') {
    if (!state.round) return state;
    return RoomStateSchema.parse({
      ...state,
      round: { ...state.round, status: 'resolved' },
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
    return RoomStateSchema.parse({
      ...state,
      seats: [...state.seats, seat],
      spotlightActivity: {
        ...(state.spotlightActivity ?? {}),
        [seat.accountId]: state.spotlightTurn ?? 0,
      },
    });
  }
  if (event.type === 'HostSeatChanged') {
    const { seatId } = event.payload as { seatId: string };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) => ({
        ...seat,
        isHost: seat.seatId === seatId,
      })),
    });
  }
  if (event.type === 'HostTransferred') {
    const { toSeatId } = event.payload as { toSeatId: string };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) => ({
        ...seat,
        isHost: seat.seatId === toSeatId,
      })),
    });
  }
  if (event.type === 'ChatMuteChanged') {
    const { seatId, muted, mutedUntil } = event.payload as {
      seatId: string;
      muted: boolean;
      mutedUntil?: number | null;
    };
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) =>
        seat.seatId === seatId
          ? {
              ...seat,
              chatMuted: muted,
              chatMutedUntil: muted ? (mutedUntil ?? null) : undefined,
            }
          : seat,
      ),
    });
  }
  if (event.type === 'LateJoinRequested') {
    const request = event.payload as NonNullable<
      RoomState['lateJoinRequests']
    >[number];
    const requestResults = {
      ...(state.lateJoinRequestResults ?? {}),
      ...(typeof request.actionId === 'string'
        ? { [`${request.accountId}:${request.actionId}`]: request.requestId }
        : {}),
    };
    const requestCharacterIds = {
      ...(state.lateJoinRequestCharacterIds ?? {}),
      ...(typeof request.actionId === 'string' &&
      typeof request.characterId === 'string'
        ? { [`${request.accountId}:${request.actionId}`]: request.characterId }
        : {}),
    };
    const boundedRequestResults = Object.fromEntries(
      Object.entries(requestResults).slice(-256),
    );
    return RoomStateSchema.parse({
      ...state,
      lateJoinRequests: [
        ...(state.lateJoinRequests ?? []).filter(
          (item) => item.requestId !== request.requestId,
        ),
        request,
      ],
      lateJoinRequestResults: boundedRequestResults,
      lateJoinRequestCharacterIds: Object.fromEntries(
        Object.entries(requestCharacterIds).slice(-256),
      ),
    });
  }
  if (event.type === 'LateJoinApproved') {
    const { requestId } = event.payload as { requestId: string };
    return RoomStateSchema.parse({
      ...state,
      lateJoinRequests: (state.lateJoinRequests ?? []).map((item) =>
        item.requestId === requestId ? { ...item, approved: true } : item,
      ),
    });
  }
  if (
    event.type === 'LateJoinDenied' ||
    event.type === 'LateJoinAdmitted' ||
    event.type === 'LateJoinExpired' ||
    event.type === 'LateJoinCancelled'
  ) {
    const { requestId, actionId, actorAccountId } = event.payload as {
      requestId: string;
      actionId?: string;
      actorAccountId?: string;
    };
    const request = (state.lateJoinRequests ?? []).find(
      (item) => item.requestId === requestId,
    );
    const requestResults = {
      ...(state.lateJoinRequestResults ?? {}),
      ...(actionId && request?.accountId
        ? { [`${request.accountId}:${actionId}`]: requestId }
        : {}),
    };
    return RoomStateSchema.parse({
      ...state,
      ...(actionId && actorAccountId
        ? {
            lateJoinActionOwners: {
              ...(state.lateJoinActionOwners ?? {}),
              [actionId]: actorAccountId,
            },
          }
        : {}),
      ...(actionId && request?.accountId
        ? {
            lateJoinRequestResults: Object.fromEntries(
              Object.entries(requestResults).slice(-256),
            ),
          }
        : {}),
      lateJoinRequests: (state.lateJoinRequests ?? []).filter(
        (item) => item.requestId !== requestId,
      ),
    });
  }
  if (event.type === 'SpotlightPrompted') {
    const { turn, cursor } = event.payload as { turn: number; cursor: number };
    return RoomStateSchema.parse({
      ...state,
      spotlightTurn: turn,
      spotlightCursor: cursor,
    });
  }
  if (event.type === 'TableEnded')
    return RoomStateSchema.parse({ ...state, ended: true, paused: true });
  if (event.type === 'SeatRevoked') {
    const { seatId } = event.payload as { seatId: string };
    const revoked = state.seats.find((seat) => seat.seatId === seatId);
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.filter((seat) => seat.seatId !== seatId),
      ...(revoked
        ? {
            revokedSeats: [
              ...(state.revokedSeats ?? []).filter(
                (seat) => seat.seatId !== seatId,
              ),
              { ...revoked, presence: 'revoked' },
            ],
          }
        : {}),
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
    const { paused, cause, restVoteRemainingMs, restVoteDeadlineAt } =
      event.payload as {
        paused: boolean;
        cause?: 'host' | 'no-connected-seats';
        restVoteRemainingMs?: number;
        restVoteDeadlineAt?: number;
      };
    const restVote = state.restVote
      ? paused && restVoteRemainingMs !== undefined
        ? {
            ...state.restVote,
            deadlineAt: null,
            remainingMs: restVoteRemainingMs,
          }
        : !paused && restVoteDeadlineAt !== undefined
          ? {
              ...state.restVote,
              deadlineAt: restVoteDeadlineAt,
              remainingMs: undefined,
            }
          : state.restVote
      : undefined;
    return RoomStateSchema.parse({
      ...state,
      paused,
      pauseCause: paused ? (cause ?? state.pauseCause ?? 'host') : undefined,
      restVote,
    });
  }
  if (
    event.type === 'PresenceChanged' ||
    event.type === 'SeatDisconnected' ||
    event.type === 'SeatAway' ||
    event.type === 'SeatReconnected'
  ) {
    const payload = event.payload as {
      seatId: string;
      presence: Seat['presence'];
    };
    const presence =
      event.type === 'SeatDisconnected'
        ? 'disconnected'
        : event.type === 'SeatAway'
          ? 'away'
          : event.type === 'SeatReconnected'
            ? 'returning'
            : payload.presence;
    return RoomStateSchema.parse({
      ...state,
      seats: state.seats.map((seat) =>
        seat.seatId === payload.seatId ? { ...seat, presence } : seat,
      ),
      presenceEventAt: {
        ...(state.presenceEventAt ?? {}),
        [payload.seatId]: event.ts.getTime(),
      },
      presenceEventType: {
        ...(state.presenceEventType ?? {}),
        [payload.seatId]: event.type as
          | 'PresenceChanged'
          | 'SeatDisconnected'
          | 'SeatAway'
          | 'SeatReconnected',
      },
    });
  }
  return state;
}
