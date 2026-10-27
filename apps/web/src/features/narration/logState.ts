import type { ServerMessage } from '@game/schema';

export type RollPayload = {
  type: 'RollEvent';
  breakdown?: {
    expression: string;
    dice: { sides: number; value: number; kept: boolean }[];
    modifiers: { label: string; value: number }[];
    total: number;
  };
  dc?: number;
  dcReason?: string;
  [key: string]: unknown;
};

export type NarrationTurn = {
  turnId: string;
  chunks: Record<number, string>;
  narration?: string;
  fallback?: 'no-narration' | 'endpoint-error' | 'budget-exhausted';
  complete: boolean;
  rollEvents: RollPayload[];
};

export type LogEntry =
  | { kind: 'pending'; actionId: string }
  | { kind: 'turn'; turn: NarrationTurn };

export type NarrationLogState = {
  entries: LogEntry[];
  announced: string[];
};

const LIVE_DM_RESTRICTED_MESSAGE = 'Live DM is not enabled for this account.';

/** Codes the server sends when the DM turn for a submitted action did not complete. */
export function isTurnFailure(code: string): boolean {
  return code === 'TURN_FAILED' || code === 'LIVE_DM_RESTRICTED';
}

/** What the sender sees beside the action box after their turn failed. */
export function turnFailureNotice(
  code: string,
  message: string,
): { message: string; canRetry: boolean } {
  // A restricted account cannot retry: the server will reject the same action again.
  if (code === 'LIVE_DM_RESTRICTED')
    return { message: LIVE_DM_RESTRICTED_MESSAGE, canRetry: false };
  return { message, canRetry: true };
}

export const initialNarrationLog: NarrationLogState = {
  entries: [],
  announced: [],
};

const turnOf = (state: NarrationLogState, turnId: string): NarrationTurn => {
  const existing = state.entries.find(
    (entry): entry is Extract<LogEntry, { kind: 'turn' }> =>
      entry.kind === 'turn' && entry.turn.turnId === turnId,
  )?.turn;
  return (
    existing ?? {
      turnId,
      chunks: {},
      complete: false,
      rollEvents: [],
    }
  );
};

function upsertTurn(
  state: NarrationLogState,
  turn: NarrationTurn,
): NarrationLogState {
  const exists = state.entries.some(
    (entry) => entry.kind === 'turn' && entry.turn.turnId === turn.turnId,
  );
  return {
    ...state,
    entries: exists
      ? state.entries.map((entry) =>
          entry.kind === 'turn' && entry.turn.turnId === turn.turnId
            ? { kind: 'turn', turn }
            : entry,
        )
      : [...state.entries, { kind: 'turn', turn }],
  };
}

/** Replays transient room messages idempotently, independent of StateSync snapshots. */
export function narrationLogReducer(
  state: NarrationLogState,
  message: ServerMessage,
): NarrationLogState {
  const payload = message.payload as Record<string, unknown>;
  switch (message.type) {
    case 'ActionQueued':
    case 'TurnThinking': {
      const actionId = String(payload.actionId ?? '');
      if (
        !actionId ||
        state.entries.some(
          (entry) => entry.kind === 'pending' && entry.actionId === actionId,
        )
      )
        return state;
      return {
        ...state,
        entries: [...state.entries, { kind: 'pending', actionId }],
      };
    }
    case 'ActionWithdrawn': {
      const actionId = String(payload.actionId ?? '');
      return {
        ...state,
        entries: state.entries.filter(
          (entry) => !(entry.kind === 'pending' && entry.actionId === actionId),
        ),
      };
    }
    case 'RollEvent': {
      const event = payload as RollPayload;
      const turnId = String(event.turnId ?? '');
      if (!turnId) return state;
      const turn = turnOf(state, turnId);
      const signature = JSON.stringify(event);
      if (turn.rollEvents.some((roll) => JSON.stringify(roll) === signature))
        return state;
      return upsertTurn(state, {
        ...turn,
        rollEvents: [...turn.rollEvents, event],
      });
    }
    case 'NarrationChunk': {
      const turnId = String(payload.turnId ?? '');
      const index = Number(payload.index);
      if (!turnId || !Number.isInteger(index) || index < 0) return state;
      const turn = turnOf(state, turnId);
      if (turn.complete || Object.hasOwn(turn.chunks, index)) return state;
      return upsertTurn(state, {
        ...turn,
        chunks: { ...turn.chunks, [index]: String(payload.text ?? '') },
      });
    }
    case 'NarrationCompleted': {
      const turnId = String(payload.turnId ?? '');
      if (!turnId) return state;
      const turn = turnOf(state, turnId);
      if (turn.complete) return state;
      const narration = String(payload.text ?? '');
      const entries = state.entries.filter((entry) => entry.kind !== 'pending');
      const next = upsertTurn(
        { ...state, entries },
        {
          ...turn,
          narration,
          ...(typeof payload.fallback === 'string'
            ? { fallback: payload.fallback as NarrationTurn['fallback'] }
            : {}),
          complete: true,
        },
      );
      return { ...next, announced: [...next.announced, turnId] };
    }
    case 'TurnReverted': {
      const turnId = String(payload.revertedTurnId ?? '');
      return {
        ...state,
        entries: state.entries.filter(
          (entry) => !(entry.kind === 'turn' && entry.turn.turnId === turnId),
        ),
        announced: state.announced.filter((id) => id !== turnId),
      };
    }
    case 'Error': {
      // Turn failures are broadcast to every seat but never enter the shared story log. A failed
      // turn only ends the shared thinking status. Only the seat whose own action failed gets its
      // text back and a Retry (Game.tsx matches the action or round id). The round path names the
      // round here, not the turn's action id, so a failed turn clears whichever turn is pending:
      // the server runs one turn at a time.
      const code = String(payload.code ?? 'ERROR');
      const actionId =
        typeof payload.actionId === 'string' ? payload.actionId : undefined;
      const turnFailed = isTurnFailure(code);
      return {
        ...state,
        entries: state.entries.filter(
          (entry) =>
            !(
              entry.kind === 'pending' &&
              (turnFailed || entry.actionId === actionId)
            ),
        ),
      };
    }
    case 'ToolRejected':
    case 'ClarificationRequested':
    case 'ContentTierChanged':
    case 'SafetyFlag':
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
    case 'TurnTimerConfigured':
    case 'SeatRevoked':
    case 'HostTransferred':
    case 'HostSeatChanged':
    case 'LateJoinRequested':
    case 'LateJoinDenied':
    case 'LateJoinApproved':
    case 'TableEnded':
    case 'ChatMuteChanged':
    case 'RestVoteOpened':
    case 'RestVoteCastNotice':
    case 'RestVoteClosed':
    case 'RestApplied':
    case 'SpotlightPrompt':
    case 'CombatTracker':
    case 'ReactionPrompt':
    case 'ReactionPromptOpen':
    case 'CombatOptions':
    case 'CombatEvents':
    case 'CombatEnded':
    case 'DeathSaveRequired':
    case 'TpkChoiceRequired':
    case 'StateSync':
    case 'SeatPrivateRoundSync':
    case 'PresenceChanged':
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
    case 'SeatCharacterBound':
    case 'SeatCharacterReleased':
    case 'SeatCharacterBoundPrivate':
      return state;
  }
}

export function visibleChunks(turn: NarrationTurn): string {
  const indexes = Object.keys(turn.chunks)
    .map(Number)
    .sort((a, b) => a - b);
  let expected = 0;
  let text = '';
  for (const index of indexes) {
    if (index !== expected) break;
    text += turn.chunks[index];
    expected += 1;
  }
  return text || (turn.complete ? (turn.narration ?? '') : '');
}
