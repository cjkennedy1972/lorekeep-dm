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

test('restored history does not show the new-narration jump control while scrolled up', async () => {
  const view = render(<NarrationLog messages={[]} />);
  const list = view.container.querySelector('ol')!;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 3_000 },
    clientHeight: { configurable: true, value: 100 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  view.rerender(
    <NarrationLog
      messages={[
        {
          seq: 1,
          type: 'NarrationHistory',
          payload: {
            turns: [
              { turnId: 'restored', text: 'An old scene.', tier: 'standard' },
            ],
          },
        } as ServerMessage,
      ]}
    />,
  );
  expect(await screen.findByText('An old scene.')).toBeInTheDocument();
  expect(list.scrollTop).toBe(3_000);
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();

  list.scrollTop = 0;
  view.rerender(
    <NarrationLog
      historyRestoreKey={2}
      messages={[
        {
          seq: 1,
          type: 'NarrationHistory',
          payload: {
            turns: [
              { turnId: 'restored', text: 'An old scene.', tier: 'standard' },
            ],
          },
        } as ServerMessage,
      ]}
    />,
  );
  expect(list.scrollTop).toBe(3_000);
});

const opening = {
  title: 'The adventure begins',
  body: 'A new journey awaits.',
};
const stateSync = {
  seq: 1,
  type: 'StateSync',
  payload: { state: {} },
} as ServerMessage;

test('shows the opening after StateSync and empty narration history are synchronized', () => {
  render(
    <NarrationLog
      messages={[
        stateSync,
        {
          seq: 2,
          type: 'NarrationHistory',
          payload: { turns: [] },
        } as ServerMessage,
      ]}
      opening={opening}
      openingReady
    />,
  );

  expect(screen.getByText('The adventure begins')).toBeInTheDocument();
  expect(screen.getByText('A new journey awaits.')).toBeInTheDocument();
});

test('does not flash the opening when synchronized narration history has turns', () => {
  const view = render(
    <NarrationLog
      messages={[stateSync]}
      opening={opening}
      openingReady={false}
    />,
  );
  expect(screen.queryByText('The adventure begins')).not.toBeInTheDocument();

  view.rerender(
    <NarrationLog
      messages={[
        stateSync,
        {
          seq: 2,
          type: 'NarrationHistory',
          payload: {
            turns: [
              {
                turnId: 'restored',
                text: 'The road stretches north.',
                tier: 'standard',
              },
            ],
          },
        } as ServerMessage,
      ]}
      opening={opening}
      openingReady
    />,
  );

  expect(screen.getByText('The road stretches north.')).toBeInTheDocument();
  expect(screen.queryByText('The adventure begins')).not.toBeInTheDocument();
});

test('shows the opening when the history synchronization fallback is ready without history', () => {
  render(
    <NarrationLog messages={[stateSync]} opening={opening} openingReady />,
  );

  expect(screen.getByText('The adventure begins')).toBeInTheDocument();
});

test('a combat batch shows one roll card per attack and announces the batch once', () => {
  const combatBatch = {
    seq: 30,
    type: 'CombatEvents',
    payload: {
      events: [
        {
          type: 'RollEvent',
          actorId: 'ent_aria',
          label: 'attack equipment:javelin',
          dice: '1d20',
          rolls: [15],
          modifier: 4,
          total: 19,
        },
        {
          type: 'RollEvent',
          actorId: 'ent_aria',
          label: 'damage equipment:javelin',
          dice: '1d6',
          rolls: [4],
          modifier: 0,
          total: 4,
        },
        {
          type: 'HpChanged',
          entityId: 'ent_goblin',
          from: 7,
          to: 3,
          damage: 4,
        },
      ],
    },
  } as unknown as ServerMessage;

  const { container } = render(
    <NarrationLog
      messages={[combatBatch]}
      combatantNames={{ ent_aria: 'Aria', ent_goblin: 'Goblin' }}
      combatantKinds={{ ent_aria: 'pc', ent_goblin: 'monster' }}
    />,
  );

  const cards = container.querySelectorAll('.narration-log__roll');
  expect(cards).toHaveLength(1);
  expect(cards[0]).toHaveTextContent('Aria');
  expect(cards[0]).toHaveTextContent('Goblin');
  expect(
    screen.getByText(/Aria/, { selector: '[role="status"]' }),
  ).toBeInTheDocument();
});
