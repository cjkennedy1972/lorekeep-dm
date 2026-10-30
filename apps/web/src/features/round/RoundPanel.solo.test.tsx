// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { type RoomState, type Seat } from '@game/schema';
import { RoundPanel } from './RoundPanel';

type Round = NonNullable<RoomState['round']>;

const ROUND_ID = '22222222-2222-4222-8222-222222222222';
const MY_ACTION = '33333333-3333-4333-8333-333333333333';

const seat = {
  seatId: 'seat-a',
  accountId: 'acct-a',
  displayName: 'Ada',
  presence: 'online',
} as Seat;

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: ROUND_ID,
    status: 'open',
    eligibleSeatIds: ['seat-a'],
    deadlineAt: null,
    submissions: [],
    queuedSubmissions: [],
    ...overrides,
  } as Round;
}

const submission = {
  seatId: 'seat-a',
  accountId: 'acct-seat-a',
  actionId: MY_ACTION,
  originalActionId: MY_ACTION,
  actionIds: [MY_ACTION],
  text: 'I search the cellar.',
  playerName: 'Ada',
  receiptSeq: 1,
} as Round['submissions'][number];

describe('RoundPanel in a solo game', () => {
  it('does not show multiplayer counts or a waiting roster to the only seat', () => {
    render(
      <RoundPanel
        round={round()}
        seats={[seat]}
        selfSeatId="seat-a"
        connected
        send={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Your turn.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/of 1 submitted/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ada: waiting')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Submitted' }),
    ).not.toBeInTheDocument();
  });

  it('does not tell a viewer without the solo seat that it is their turn', () => {
    render(
      <RoundPanel
        round={round()}
        seats={[seat]}
        selfSeatId="seat-spectator"
        connected
        send={vi.fn()}
      />,
    );

    expect(screen.queryByText('Your turn.')).not.toBeInTheDocument();
    expect(
      screen.getAllByText('Waiting for the only player.').length,
    ).toBeGreaterThan(0);
  });

  it('does not tell a viewer without the solo seat that their action is in', () => {
    render(
      <RoundPanel
        round={round({ submissions: [submission] })}
        seats={[seat]}
        selfSeatId="seat-spectator"
        connected
        send={vi.fn()}
      />,
    );

    expect(screen.queryByText('Your action is in.')).not.toBeInTheDocument();
    expect(
      screen.getAllByText('The only player has submitted.').length,
    ).toBeGreaterThan(0);
  });

  it('confirms the action is in once the only seat has submitted', () => {
    render(
      <RoundPanel
        round={round({ submissions: [submission] })}
        seats={[seat]}
        selfSeatId="seat-a"
        myActionId={MY_ACTION}
        myText="I search the cellar."
        connected
        send={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Your action is in.').length).toBeGreaterThan(0);
    expect(screen.queryByText(/submitted\./)).not.toBeInTheDocument();
  });

  it('keeps the multiplayer summary when more than one seat is eligible', () => {
    render(
      <RoundPanel
        round={round({
          eligibleSeatIds: ['seat-a', 'seat-b'] as Round['eligibleSeatIds'],
        })}
        seats={[seat]}
        selfSeatId="seat-a"
        connected
        send={vi.fn()}
      />,
    );

    expect(screen.getAllByText('0 of 2 submitted.').length).toBeGreaterThan(0);
  });
});
