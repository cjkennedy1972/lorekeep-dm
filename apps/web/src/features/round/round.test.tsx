import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccountIdSchema, type RoomState, type Seat } from '@game/schema';
import { roomReducer, initialRoomView } from '../../room/reducer';
import { RoundPanel, isOwnSubmission, secondsLeft } from './RoundPanel';
import { HostControls, clampTimerSeconds } from './HostControls';

type Round = NonNullable<RoomState['round']>;

const SESSION = '11111111-1111-4111-8111-111111111111';
const ROUND_ID = '22222222-2222-4222-8222-222222222222';
const MY_ACTION = '33333333-3333-4333-8333-333333333333';
const OTHER_ACTION = '44444444-4444-4444-8444-444444444444';

const seats: Seat[] = [
  {
    seatId: 'seat-a',
    accountId: 'acct-a',
    displayName: 'Ada',
    presence: 'online',
  } as Seat,
  {
    seatId: 'seat-b',
    accountId: 'acct-b',
    displayName: 'Bo',
    presence: 'online',
  } as Seat,
];

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: ROUND_ID,
    status: 'open',
    eligibleSeatIds: ['seat-a', 'seat-b'],
    deadlineAt: null,
    submissions: [],
    queuedSubmissions: [],
    ...overrides,
  } as Round;
}

const submission = (seatId: string, actionId: string, text = 'I wait.') =>
  ({
    seatId,
    accountId: `acct-${seatId}`,
    actionId,
    originalActionId: actionId,
    actionIds: [actionId],
    text,
    playerName: seatId,
    receiptSeq: 1,
  }) as Round['submissions'][number];

describe('round helpers', () => {
  it('matches own submission by any known action id', () => {
    const item = submission('seat-a', MY_ACTION);
    expect(isOwnSubmission(item, MY_ACTION)).toBe(true);
    expect(isOwnSubmission(item, OTHER_ACTION)).toBe(false);
    expect(isOwnSubmission(item, undefined)).toBe(false);
  });

  it('reports whole seconds left, and null without a deadline', () => {
    expect(secondsLeft(round({ deadlineAt: 10_500 }), 0)).toBe(11);
    expect(secondsLeft(round({ deadlineAt: 0 }), 5)).toBe(0);
    expect(secondsLeft(round(), 0)).toBeNull();
    expect(secondsLeft(round({ remainingMs: 61_000 }), 0)).toBe(61);
  });
});

describe('RoundPanel', () => {
  it('shows submitted and waiting seats with the open summary', () => {
    render(
      <RoundPanel
        round={round({ submissions: [submission('seat-a', OTHER_ACTION)] })}
        seats={seats}
        connected
        send={vi.fn(() => 'id')}
      />,
    );
    expect(screen.getAllByText('1 of 2 submitted.').length).toBeGreaterThan(0);
    expect(screen.getByText('Ada: submitted')).toBeTruthy();
    expect(screen.getByText('Bo: waiting')).toBeTruthy();
    expect(screen.getByText('No time limit.')).toBeTruthy();
  });

  it('edits own action with the wire EditAction payload', () => {
    const send = vi.fn(() => 'id');
    render(
      <RoundPanel
        round={round({ submissions: [submission('seat-a', MY_ACTION)] })}
        seats={seats}
        myActionId={MY_ACTION}
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit action' }));
    fireEvent.change(screen.getByLabelText('Edit your action'), {
      target: { value: 'I open the door.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(send).toHaveBeenCalledWith('EditAction', {
      editedActionId: MY_ACTION,
      text: 'I open the door.',
    });
  });

  it('withdraws own queued action and labels it as queued', () => {
    const send = vi.fn(() => 'id');
    render(
      <RoundPanel
        round={round({ queuedSubmissions: [submission('seat-a', MY_ACTION)] })}
        seats={seats}
        myActionId={MY_ACTION}
        connected
        send={send}
      />,
    );
    expect(screen.getByText(/Queued for the next round/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw action' }));
    expect(send).toHaveBeenCalledWith('WithdrawAction', {
      withdrawnActionId: MY_ACTION,
    });
  });

  it('hides edit and withdraw once the round is closing', () => {
    render(
      <RoundPanel
        round={round({
          status: 'closing',
          closeReason: 'timer',
          submissions: [submission('seat-a', MY_ACTION)],
        })}
        seats={seats}
        myActionId={MY_ACTION}
        connected
        send={vi.fn(() => 'id')}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit action' })).toBeNull();
    expect(screen.getByText(/The time ran out\./)).toBeTruthy();
  });
});

describe('clampTimerSeconds', () => {
  it('keeps in-range values and clamps to the 30 s floor and 600 s cap', () => {
    expect(clampTimerSeconds(120)).toBe(120);
    expect(clampTimerSeconds(30)).toBe(30);
    expect(clampTimerSeconds(600)).toBe(600);
    expect(clampTimerSeconds(5)).toBe(30);
    expect(clampTimerSeconds(-10)).toBe(30);
    expect(clampTimerSeconds(601)).toBe(600);
    expect(clampTimerSeconds(45.5)).toBe(46);
  });
});

describe('HostControls', () => {
  it('saves a valid timer as milliseconds', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText('No time limit'));
    fireEvent.change(screen.getByLabelText(/Round timer in seconds/), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save round timer' }));
    expect(send).toHaveBeenCalledWith('ConfigureRoundTimer', {
      durationMs: 120_000,
    });
  });

  it('clamps an out-of-range timer to 30 s and says so', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText('No time limit'));
    fireEvent.change(screen.getByLabelText(/Round timer in seconds/), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save round timer' }));
    expect(send).toHaveBeenCalledWith('ConfigureRoundTimer', {
      durationMs: 30_000,
    });
    expect(screen.getByRole('status').textContent).toContain('30 seconds');
  });

  it('rejects a non-numeric timer without sending', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByLabelText('No time limit'));
    fireEvent.change(screen.getByLabelText(/Round timer in seconds/), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save round timer' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Enter a number');
  });

  it('disables resolve-now while the table is paused', () => {
    const open = round();
    const { rerender } = render(
      <HostControls
        round={open}
        roundDurationMs={null}
        connected
        send={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Resolve round now',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    rerender(
      <HostControls
        round={open}
        roundDurationMs={null}
        connected
        paused
        send={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Resolve round now',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('explains automatic resume during a no-connected-seats pause', () => {
    render(
      <HostControls
        round={round()}
        roundDurationMs={null}
        connected
        paused
        pauseCause="no-connected-seats"
        send={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Table paused: waiting for players to reconnect. It will resume automatically when a seat is confirmed connected.',
      ),
    ).toBeTruthy();
  });

  it('lists the other players, never the host’s own seat', () => {
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={vi.fn()}
        seats={seats}
        selfSeatId="seat-a"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Remove Ada' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Bo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make Bo host' })).toBeTruthy();
  });

  it('shows transfer host disabled when no other player can take host', () => {
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={vi.fn()}
        seats={[seats[0]!]}
        selfSeatId="seat-a"
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Transfer host',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('transfers host only after confirming', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
        seats={seats}
        selfSeatId="seat-a"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make Bo host' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make host' }));
    expect(send).toHaveBeenCalledWith('TransferHost', { seatId: 'seat-b' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('removes a player only after confirming, and Escape cancels with focus back on the opener', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
        seats={seats}
        selfSeatId="seat-a"
      />,
    );
    const opener = screen.getByRole('button', { name: 'Remove Bo' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends KickSeat when the removal is confirmed', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
        seats={seats}
        selfSeatId="seat-a"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove player' }));
    expect(send).toHaveBeenCalledWith('KickSeat', { seatId: 'seat-b' });
    expect(screen.getByRole('status').textContent).toContain('Removing Bo');
  });

  it('ends the table only after confirming', () => {
    const send = vi.fn(() => 'id');
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'End the table' }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End table' }));
    expect(send).toHaveBeenCalledWith('EndTable', {});
  });

  it('approves and denies late joiners by request id', () => {
    const send = vi.fn(() => 'id');
    const requestId = '55555555-5555-4555-8555-555555555555';
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={send}
        lateJoinRequests={[
          {
            requestId,
            accountId: AccountIdSchema.parse(
              '00000000-0000-4000-8000-0000000000c1',
            ),
            displayName: 'Cy',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve Cy' }));
    expect(send).toHaveBeenLastCalledWith('ApproveLateJoin', { requestId });
    fireEvent.click(screen.getByRole('button', { name: 'Deny Cy' }));
    expect(send).toHaveBeenLastCalledWith('DenyLateJoin', { requestId });
  });

  it('disables destructive actions while disconnected', () => {
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected={false}
        send={vi.fn()}
        seats={seats}
        selfSeatId="seat-a"
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Remove Bo' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'End the table',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('roomReducer round events', () => {
  it('advances the round event seq and accepts an equal-sequence StateSync', () => {
    const synced = roomReducer(initialRoomView, {
      seq: 5,
      type: 'StateSync',
      payload: {
        state: {
          sessionId: SESSION,
          phase: 'lobby',
          seats: [],
        },
      },
    } as never);
    const afterRound = roomReducer(synced, {
      seq: 6,
      type: 'RoundOpened',
      payload: {},
    } as never);
    expect(afterRound.needsResync).toBe(true);
    expect(afterRound.lastSeq).toBe(6);
    const resynced = roomReducer(afterRound, {
      seq: 6,
      type: 'StateSync',
      payload: { state: synced.room! },
    } as never);
    expect(resynced.lastSeq).toBe(6);
    expect(resynced.needsResync).toBe(false);
  });
});
