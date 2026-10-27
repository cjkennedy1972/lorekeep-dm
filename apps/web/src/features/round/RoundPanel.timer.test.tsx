// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { RoomState, Seat } from '@game/schema';
import { RoundPanel } from './RoundPanel';

type Round = NonNullable<RoomState['round']>;

const seats = [
  {
    seatId: 'seat-a',
    accountId: 'acct-a',
    displayName: 'Ada',
    presence: 'online',
  },
] as Seat[];

test('a timed round says what happens when the timer reaches 0:00', () => {
  const round = {
    roundId: '22222222-2222-4222-8222-222222222222',
    status: 'open',
    eligibleSeatIds: ['seat-a'],
    deadlineAt: Date.now() + 120_000,
    submissions: [],
    queuedSubmissions: [],
  } as unknown as Round;

  render(
    <RoundPanel
      round={round}
      seats={seats}
      connected
      send={vi.fn().mockReturnValue(false)}
    />,
  );

  expect(
    screen.getByText(
      'When the timer reaches 0:00, the round closes and resolves with the actions submitted so far.',
    ),
  ).toBeInTheDocument();
});
