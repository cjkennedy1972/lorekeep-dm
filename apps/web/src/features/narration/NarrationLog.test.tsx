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
