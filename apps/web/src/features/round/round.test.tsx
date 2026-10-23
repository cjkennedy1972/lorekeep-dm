import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RoomState, Seat } from '@game/schema';
import { roomReducer, initialRoomView } from '../../room/reducer';
import { RoundPanel, isOwnSubmission, secondsLeft } from './RoundPanel';
import { HostControls, timerMsFromSeconds } from './HostControls';

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

describe('timerMsFromSeconds', () => {
  it('accepts the 30 s floor and 600 s cap and rejects outside them', () => {
    expect(timerMsFromSeconds(30)).toEqual({ ok: true, durationMs: 30_000 });
    expect(timerMsFromSeconds(600)).toEqual({ ok: true, durationMs: 600_000 });
    expect(timerMsFromSeconds(null)).toEqual({ ok: true, durationMs: null });
    expect(timerMsFromSeconds(29).ok).toBe(false);
    expect(timerMsFromSeconds(601).ok).toBe(false);
    expect(timerMsFromSeconds(45.5).ok).toBe(false);
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

  it('rejects an out-of-range timer without sending', () => {
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
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('30 to 600');
  });

  it('keeps unsupported host actions disabled', () => {
    render(
      <HostControls
        round={undefined}
        roundDurationMs={null}
        connected
        send={vi.fn()}
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
});

describe('roomReducer round events', () => {
  it('asks for a resync without advancing lastSeq, so the StateSync is applied', () => {
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
    expect(afterRound.lastSeq).toBe(5);
    const resynced = roomReducer(afterRound, {
      seq: 6,
      type: 'StateSync',
      payload: { state: synced.room! },
    } as never);
    expect(resynced.lastSeq).toBe(6);
    expect(resynced.needsResync).toBe(false);
  });
});
