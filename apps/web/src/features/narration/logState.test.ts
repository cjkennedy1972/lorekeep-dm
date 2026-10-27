import { expect, test } from 'vitest';
import type { ServerMessage } from '@game/schema';
import {
  initialNarrationLog,
  narrationLogReducer,
  turnFailureNotice,
} from './logState.js';

const replay = (messages: ServerMessage[]) =>
  messages.reduce(narrationLogReducer, initialNarrationLog);

test('a failed round turn clears the thinking entry even though the error names the round', () => {
  // Round-path failures report the round id, while TurnThinking carries the turn's action id.
  const state = replay([
    {
      seq: 1,
      type: 'ActionQueued',
      payload: { actionId: 'action-1' },
    } as ServerMessage,
    {
      seq: 2,
      type: 'TurnThinking',
      payload: { actionId: 'action-1' },
    } as ServerMessage,
    {
      seq: 3,
      type: 'Error',
      payload: {
        code: 'TURN_FAILED',
        message: 'The DM could not complete that round. Try again.',
        actionId: 'round-1',
      },
    } as ServerMessage,
  ]);

  expect(state.entries).toEqual([]);
});

test('a turn failure notice keeps the server message and offers a retry', () => {
  expect(
    turnFailureNotice('TURN_FAILED', 'The DM could not complete that round.'),
  ).toEqual({
    message: 'The DM could not complete that round.',
    canRetry: true,
  });
});

test('a restricted account is told live DM is not enabled, with no retry', () => {
  expect(
    turnFailureNotice(
      'LIVE_DM_RESTRICTED',
      'The DM could not complete that round. Try again.',
    ),
  ).toEqual({
    message: 'Live DM is not enabled for this account.',
    canRetry: false,
  });
});
