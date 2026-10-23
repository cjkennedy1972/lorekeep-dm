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
}

export const initialRoomView: RoomView = {
  room: null,
  lastSeq: 0,
  needsResync: false,
};

/** Pure reducer: StateSync replaces; sequenced patches apply only when seq === lastSeq + 1. */
export function roomReducer(view: RoomView, msg: ServerMessage): RoomView {
  switch (msg.type) {
    case 'StateSync':
      if (msg.seq <= view.lastSeq && view.room) return view; // duplicate/stale snapshot
      return {
        room: { ...msg.payload.state, round: msg.payload.round },
        lastSeq: msg.seq,
        needsResync: false,
      };
    case 'PresenceChanged': {
      if (msg.seq <= view.lastSeq) return view; // duplicate or out-of-order
      if (!view.room || msg.seq !== view.lastSeq + 1)
        return view.needsResync ? view : { ...view, needsResync: true };
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
    case 'RoundActionWithdrawn':
    case 'RoundClosing':
    case 'RoundResolved':
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
      return view.needsResync ? view : { ...view, needsResync: true };
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
      return view; // surfaced by the client, not part of room state
  }
}
