// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ActionInput } from './ActionInput.js';

test('a queued action is named in the sticky dock, not only in the round panel', () => {
  render(
    <ActionInput
      onSubmit={vi.fn()}
      pending
      pendingText="I search the cellar."
      pendingSince={Date.now()}
      queuedForNextRound
    />,
  );

  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Queued: I search the cellar.');
  expect(status).toHaveTextContent('Queued for the next round.');
});

test('the dock shows no queued notice when the action is not queued', () => {
  render(
    <ActionInput
      onSubmit={vi.fn()}
      pending
      pendingText="I search the cellar."
      pendingSince={Date.now()}
    />,
  );

  expect(
    screen.queryByText('Queued for the next round.'),
  ).not.toBeInTheDocument();
});
