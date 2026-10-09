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
  complete: boolean;
  rollEvents: RollPayload[];
};

export type LogEntry =
  | { kind: 'pending'; actionId: string }
  | { kind: 'turn'; turn: NarrationTurn }
  | { kind: 'error'; actionId?: string; code: string; message: string };

export type NarrationLogState = {
  entries: LogEntry[];
  announced: string[];
};

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
        { ...turn, narration, complete: true },
      );
      return { ...next, announced: [...next.announced, turnId] };
    }
    case 'Error': {
      const code = String(payload.code ?? 'ERROR');
      const actionId =
        typeof payload.actionId === 'string' ? payload.actionId : undefined;
      const entries = state.entries.filter(
        (entry) => !(entry.kind === 'pending' && entry.actionId === actionId),
      );
      return {
        ...state,
        entries: [
          ...entries,
          {
            kind: 'error',
            ...(actionId ? { actionId } : {}),
            code,
            message: String(
              payload.message ?? 'The action could not be completed.',
            ),
          },
        ],
      };
    }
    case 'ToolRejected':
    case 'StateSync':
    case 'PresenceChanged':
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
  return turn.complete ? (turn.narration ?? '') : text;
}
