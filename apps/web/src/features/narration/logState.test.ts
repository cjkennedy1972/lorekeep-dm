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

test('narration history replays once and replaces duplicate live turns by turn id', () => {
  const history = {
    seq: 7,
    type: 'NarrationHistory',
    payload: {
      turns: [
        {
          turnId: 'turn-old',
          text: 'Old scene.',
          tier: 'standard',
          actionText: 'I look around.',
        },
        { turnId: 'turn-live', text: 'Live scene.', tier: 'family' },
      ],
    },
  } as unknown as ServerMessage;
  const live = {
    seq: 9,
    type: 'NarrationCompleted',
    payload: { turnId: 'turn-live', text: 'Live scene updated.' },
  } as ServerMessage;

  const liveFirst = narrationLogReducer(initialNarrationLog, live);
  const once = narrationLogReducer(liveFirst, history);
  const twice = narrationLogReducer(once, history);
  const withLive = narrationLogReducer(twice, live);

  expect(withLive.entries).toHaveLength(2);
  expect(withLive.entries[0]).toMatchObject({
    kind: 'turn',
    turn: { turnId: 'turn-old' },
  });
  expect(withLive.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn',
        turn: expect.objectContaining({
          turnId: 'turn-old',
          narration: 'Old scene.',
          playerText: 'I look around.',
        }),
      }),
      expect.objectContaining({
        kind: 'turn',
        turn: expect.objectContaining({
          turnId: 'turn-live',
          narration: 'Live scene updated.',
        }),
      }),
    ]),
  );
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

test('a restriction named by the round is a generic retryable failure, not a restriction notice', () => {
  expect(
    turnFailureNotice('LIVE_DM_RESTRICTED', 'Live DM is not enabled.', true),
  ).toEqual({
    message: 'The DM could not complete that turn.',
    canRetry: true,
  });
});

test('history never restores a reverted turn or overwrites a live turn', () => {
  const reverted = replay([
    {
      seq: 1,
      type: 'TurnReverted',
      payload: { revertedTurnId: 'turn-old' },
    } as ServerMessage,
    {
      seq: 2,
      type: 'NarrationHistory',
      payload: {
        turns: [{ turnId: 'turn-old', text: 'Restored?', tier: 'standard' }],
      },
    } as unknown as ServerMessage,
  ]);
  expect(reverted.entries).toEqual([]);

  const live = replay([
    {
      seq: 1,
      type: 'ActionQueued',
      payload: { actionId: 'action' },
    } as ServerMessage,
    {
      seq: 2,
      type: 'NarrationChunk',
      payload: { turnId: 'turn-streaming', index: 0, text: 'Live ' },
    } as ServerMessage,
    {
      seq: 3,
      type: 'NarrationHistory',
      payload: {
        turns: [
          {
            turnId: 'turn-streaming',
            text: 'History complete.',
            tier: 'standard',
          },
        ],
      },
    } as unknown as ServerMessage,
  ]);
  expect(live.entries).toEqual([
    { kind: 'pending', actionId: 'action' },
    {
      kind: 'turn',
      turn: {
        turnId: 'turn-streaming',
        chunks: { 0: 'Live ' },
        complete: false,
        rollEvents: [],
      },
    },
  ]);
});
