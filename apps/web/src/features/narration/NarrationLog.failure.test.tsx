// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { ServerMessage } from '@game/schema';
import { NarrationLog } from './NarrationLog.js';

const queued = [
  { seq: 1, type: 'ActionQueued', payload: { actionId: 'action-1' } },
  { seq: 2, type: 'TurnThinking', payload: { actionId: 'action-1' } },
] as ServerMessage[];

test('a failed turn clears the thinking status without writing the error into the shared story', () => {
  render(
    <NarrationLog
      messages={[
        ...queued,
        {
          seq: 3,
          type: 'Error',
          payload: {
            code: 'TURN_FAILED',
            message: 'The DM could not complete that round. Try again.',
            actionId: 'round-1',
          },
        } as ServerMessage,
      ]}
    />,
  );

  expect(screen.queryByText('The DM is thinking…')).not.toBeInTheDocument();
  expect(
    screen.queryByText('The DM could not complete that round. Try again.'),
  ).not.toBeInTheDocument();
});

test('a restricted account failure does not reach the shared story log', () => {
  render(
    <NarrationLog
      messages={[
        ...queued,
        {
          seq: 3,
          type: 'Error',
          payload: { code: 'LIVE_DM_RESTRICTED', message: 'x' },
        } as ServerMessage,
      ]}
    />,
  );

  expect(screen.queryByText('The DM is thinking…')).not.toBeInTheDocument();
  expect(
    screen.queryByText('Live DM is not enabled for this account.'),
  ).not.toBeInTheDocument();
});
