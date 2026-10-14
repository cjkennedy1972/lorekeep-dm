import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@game/schema';
import {
  initialNarrationLog,
  narrationLogReducer,
} from '../src/features/narration/logState.js';

const completed = (turnId: string, text: string): ServerMessage =>
  ({
    seq: 1,
    type: 'NarrationCompleted',
    payload: { turnId, text },
  }) as ServerMessage;

describe('TurnReverted on the client', () => {
  it('retracts the reverted turn from the transcript and announcements', () => {
    let log = narrationLogReducer(
      initialNarrationLog,
      completed('turn-1', 'kept'),
    );
    log = narrationLogReducer(log, completed('turn-2', 'reverted'));

    log = narrationLogReducer(log, {
      seq: 3,
      type: 'TurnReverted',
      payload: { revertedTurnId: 'turn-2' },
    } as ServerMessage);

    expect(
      log.entries.map((entry) => entry.kind === 'turn' && entry.turn.turnId),
    ).toEqual(['turn-1']);
    expect(log.announced).toEqual(['turn-1']);
  });
});
