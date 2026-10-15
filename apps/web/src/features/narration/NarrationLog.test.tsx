// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { ServerMessage } from '@game/schema';
import { NarrationLog } from './NarrationLog.js';

const narration = {
  seq: 12,
  type: 'NarrationCompleted',
  payload: { turnId: 'turn-1', text: 'The door opens.' },
} as ServerMessage;

test('a player can report a narration with category and optional reason', async () => {
  const onReport = vi.fn().mockResolvedValue(null);
  render(<NarrationLog messages={[narration]} onReport={onReport} />);

  fireEvent.click(screen.getByRole('button', { name: 'Report this message' }));
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'harassment' },
  });
  fireEvent.change(screen.getByLabelText('Optional details'), {
    target: { value: 'Targeted insult' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

  await waitFor(() =>
    expect(onReport).toHaveBeenCalledWith(12, 'harassment', 'Targeted insult'),
  );
  expect(
    await screen.findByText('Report received. Thank you.'),
  ).toBeInTheDocument();
});

test('ToolRejected with the wire payload is not rendered as narration', () => {
  render(
    <NarrationLog
      messages={[
        {
          seq: 14,
          type: 'ToolRejected',
          payload: { turnId: 'turn-rejected' },
        },
      ]}
    />,
  );

  expect(screen.queryByText('turn-rejected')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Report this message' }),
  ).not.toBeInTheDocument();
});

test('a rewind is announced in the story log', () => {
  render(
    <NarrationLog
      messages={[
        {
          seq: 13,
          type: 'TurnReverted',
          payload: { revertedTurnId: 'turn-1' },
        } as ServerMessage,
      ]}
    />,
  );
  const banner = screen.getByText(/The host rewound the last DM turn/);
  expect(banner).toHaveAttribute('aria-live', 'polite');
  expect(banner).toHaveTextContent(
    'The host rewound the last DM turn. Its narration and game state were restored; the next attempt uses a new dice roll.',
  );
});

test('renders one report status for multiple reportable narrations', async () => {
  const onReport = vi.fn().mockResolvedValue(null);
  const second = {
    seq: 13,
    type: 'NarrationCompleted',
    payload: { turnId: 'turn-2', text: 'The chest opens.' },
  } as ServerMessage;
  render(<NarrationLog messages={[narration, second]} onReport={onReport} />);

  fireEvent.click(
    screen.getAllByRole('button', { name: 'Report this message' })[0]!,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

  await waitFor(() => expect(onReport).toHaveBeenCalledOnce());
  expect(
    await screen.findByText('Report received. Thank you.', {
      selector: '[role=status]',
    }),
  ).toBeInTheDocument();
  expect(
    screen.getAllByText('Report received. Thank you.', {
      selector: '[role=status]',
    }),
  ).toHaveLength(1);
});

test('does not put non-narration server payloads in the shared story log', () => {
  render(
    <NarrationLog
      messages={[
        {
          seq: 20,
          type: 'Error',
          payload: { code: 'PRIVATE', message: 'Private per-seat detail' },
        } as ServerMessage,
        {
          seq: 22,
          type: 'PrivateNarrationLikePayload',
          payload: {
            text: 'Should not appear',
            narrative: 'Should not appear',
            narration: 'Should not appear',
            playerName: 'Should not appear',
          },
        } as unknown as ServerMessage,
        {
          seq: 21,
          type: 'CombatEvents',
          payload: {
            events: [{ type: 'PrivateEvent', text: 'Hidden detail' }],
          },
        } as ServerMessage,
        narration,
      ]}
    />,
  );

  expect(screen.getByText('The door opens.')).toBeInTheDocument();
  expect(screen.queryByText('Private per-seat detail')).not.toBeInTheDocument();
  expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
  expect(screen.queryByText('Hidden detail')).not.toBeInTheDocument();
});
