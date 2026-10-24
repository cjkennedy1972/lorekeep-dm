import type { RoomState, RoundSnapshot, ServerMessage } from '@game/schema';

/** Client room view: the StateSync round is the public snapshot, which omits submission text. */
export type ClientRoomState = Omit<RoomState, 'round'> & {
  round?: RoundSnapshot;
};

export interface RoomView {
  room: ClientRoomState | null;
  lastSeq: number;
  /** True when a seq gap was seen; the client must send a resync request. */
  needsResync: boolean;
  privateRoundSubmission?: {
    roundId: string;
    actionId: string;
    text: string;
    queued: boolean;
  };
  roundCloseAnnouncement?: {
    roundId: string;
    closeReason: NonNullable<RoundSnapshot['closeReason']>;
    summary: string;
  };
}

export const initialRoomView: RoomView = {
  room: null,
  lastSeq: 0,
  needsResync: false,
};

function needsRoundResync(view: RoomView, msg: ServerMessage): RoomView {
  if (msg.seq <= view.lastSeq) return view;
  if (!view.room || msg.seq !== view.lastSeq + 1)
    return view.needsResync ? view : { ...view, needsResync: true };
  return { ...view, lastSeq: msg.seq, needsResync: true };
}

/** Pure reducer: StateSync replaces; sequenced patches apply only when seq === lastSeq + 1. */
export function roomReducer(view: RoomView, msg: ServerMessage): RoomView {
  switch (msg.type) {
    case 'SeatPrivateRoundSync':
      return {
        ...view,
        privateRoundSubmission: msg.payload.submission
          ? { roundId: msg.payload.roundId, ...msg.payload.submission }
          : undefined,
      };
    case 'StateSync':
      // While a resync is pending, an equal-sequence snapshot answers it; older ones stay stale.
      if (
        view.room &&
        (msg.seq < view.lastSeq ||
          (msg.seq === view.lastSeq && !view.needsResync))
      )
        return view; // duplicate/stale snapshot
      return {
        room: { ...msg.payload.state, round: msg.payload.round },
        lastSeq: msg.seq,
        needsResync: false,
        ...(view.privateRoundSubmission &&
        msg.payload.round?.roundId === view.privateRoundSubmission.roundId
          ? { privateRoundSubmission: view.privateRoundSubmission }
          : { privateRoundSubmission: undefined }),
        ...(view.roundCloseAnnouncement
          ? { roundCloseAnnouncement: view.roundCloseAnnouncement }
          : {}),
      };
    case 'RoundClosing': {
      if (msg.seq <= view.lastSeq) return view;
      const roundId = String(msg.payload.roundId ?? '');
      const round = view.room?.round;
      const closeReason = msg.payload.closeReason;
      const roundCloseAnnouncement =
        typeof closeReason === 'string'
          ? {
              roundId,
              closeReason: closeReason as NonNullable<
                RoundSnapshot['closeReason']
              >,
              summary: round
                ? `${round.eligibleSeatIds.filter((id) => round.submissions.some((item) => item.seatId === id)).length} of ${round.eligibleSeatIds.length} submitted.`
                : 'Round closed.',
            }
          : view.roundCloseAnnouncement;
      if (!view.room || msg.seq !== view.lastSeq + 1)
        return {
          ...view,
          ...(roundCloseAnnouncement ? { roundCloseAnnouncement } : {}),
          needsResync: true,
        };
      return {
        ...view,
        lastSeq: msg.seq,
        ...(roundCloseAnnouncement ? { roundCloseAnnouncement } : {}),
        room: {
          ...view.room,
          ...(round?.roundId === roundId
            ? {
                round: {
                  ...round,
                  status: 'closing',
                  ...(typeof closeReason === 'string'
                    ? {
                        closeReason: closeReason as NonNullable<
                          RoundSnapshot['closeReason']
                        >,
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    }
    case 'RoundResolved': {
      const roundId = String(msg.payload.roundId ?? '');
      const next = needsRoundResync(view, msg);
      return {
        ...next,
        ...(view.privateRoundSubmission?.roundId === roundId
          ? { privateRoundSubmission: undefined }
          : {}),
      };
    }
    case 'PresenceChanged': {
      if (msg.seq <= view.lastSeq) return view; // duplicate or out-of-order
      if (!view.room || msg.seq !== view.lastSeq + 1)
        return needsRoundResync(view, msg);
      const { seatId, presence } = msg.payload;
      return {
        ...view,
        lastSeq: msg.seq,
        room: {
          ...view.room,
          seats: view.room.seats.map((s) =>
            s.seatId === seatId ? { ...s, presence } : s,
          ),
        },
      };
    }
    case 'RoundOpened':
    case 'RoundActionAccepted':
    case 'RoundActionQueued':
    case 'RoundActionEdited':
    case 'RoundActionWithdrawn': {
      const next = needsRoundResync(view, msg);
      if (!view.roundCloseAnnouncement) return next;
      const roundId = String(msg.payload.roundId ?? '');
      if (roundId === view.roundCloseAnnouncement.roundId) return next;
      return { ...next, roundCloseAnnouncement: undefined };
    }
    case 'RoundCompleted':
    case 'RoundClosedEmpty':
    case 'RoundTimerConfigured':
    case 'SeatRevoked':
    case 'HostTransferred':
    case 'HostSeatChanged':
    case 'LateJoinRequested':
    case 'LateJoinDenied':
    case 'LateJoinApproved':
    case 'TableEnded':
    case 'ChatMuteChanged':
      // Round broadcasts carry thin payloads, not full submissions; the full round arrives in a StateSync after a Resync.
      return needsRoundResync(view, msg);
    case 'ActionQueued':
    case 'ActionWithdrawn':
    case 'TurnThinking':
    case 'RollEvent':
    case 'NarrationChunk':
    case 'NarrationCompleted':
    case 'TurnReverted':
    case 'ToolRejected':
    case 'ClarificationRequested':
    case 'ContentTierChanged':
    case 'SafetyFlag':
    case 'RestVoteOpened':
    case 'RestVoteCastNotice':
    case 'RestVoteClosed':
    case 'RestApplied':
    case 'SpotlightPrompt':
      return view; // surfaced by the client, not part of room state
    case 'CombatTracker':
    case 'ReactionPrompt':
    case 'CombatOptions':
    case 'CombatEvents':
    case 'CombatEnded':
    case 'DeathSaveRequired':
    case 'TpkChoiceRequired':
      return view; // surfaced by the client, not part of room state
    case 'Error':
    case 'ChatMessage':
    case 'ChatHistory':
    case 'SeatTakenOver':
    case 'SeatClaimRequested':
    case 'SeatClaimApproved':
    case 'SeatClaimDenied':
    case 'SeatClaimExpired':
    case 'SeatAuthenticated':
    case 'SeatClaimPending':
    case 'SeatResumeChallenge':
      return view; // surfaced by the client, not part of room state
  }
}
