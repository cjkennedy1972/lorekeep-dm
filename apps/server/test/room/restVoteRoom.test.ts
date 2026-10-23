import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';

afterEach(() => vi.useRealTimers());

function setup(deadlineAt: number, runner?: SoloTurnRunner) {
  const sessionId = randomUUID();
  const accounts = Array.from({ length: 4 }, () => randomUUID());
  const seats = accounts.map((accountId) => ({
    seatId: randomUUID(),
    accountId,
    displayName: accountId,
    presence: 'online' as const,
  }));
  const voteId = randomUUID();
  const events: StoredEvent[] = [];
  const store = {
    async writeTurn(
      _id: string,
      inputs: Array<Omit<StoredEvent, 'sessionId' | 'seq' | 'ts'>>,
    ) {
      const stored = inputs.map((input, index) => ({
        ...input,
        sessionId,
        seq: events.length + index + 1,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      return { events: stored };
    },
    async isTableHost(_sessionId: string, accountId: string) {
      return accountId === accounts[0];
    },
  } as unknown as RoomStore;
  const latest = {
    snapshot: {
      sessionId,
      seq: 0,
      state: {
        sessionId,
        phase: 'lobby',
        seats,
        restVoteCount: 1,
        restVote: {
          voteId,
          type: 'short',
          eligibleSeats: seats.map((seat) => seat.seatId),
          ballots: [
            { seat: seats[0]!.seatId, choice: 'yes' },
            { seat: seats[1]!.seatId, choice: 'no' },
            { seat: seats[2]!.seatId, choice: 'no' },
          ],
          castSeatIds: seats.slice(0, 3).map((seat) => seat.seatId),
          openedByTurnId: randomUUID(),
          deadlineAt,
        },
      },
    },
    events: [],
  } as unknown as LatestState;
  const room = new Room(
    store,
    {
      sessionId,
      nodeId: 'test',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    },
    latest,
    runner,
  );
  return { room, events, accounts, seats, voteId };
}

const connectAll = async (room: Room, accounts: string[]) => {
  await Promise.all(
    accounts.map((accountId) => room.subscribe(accountId, { send() {} })),
  );
};

describe('rest vote close races through the Room mailbox', () => {
  it('final quorum cast wins before the deadline timer and persists one no-majority close', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 500;
    const { room, events, accounts, seats, voteId } = setup(deadline);
    await connectAll(room, accounts);

    await room.castRestVote(accounts[3]!, voteId, 'no', 'ballot', randomUUID());
    await vi.advanceTimersByTimeAsync(500);

    const closes = events.filter((event) => event.type === 'RestVoteClosed');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.payload).toMatchObject({
      outcome: 'failed',
      closeReason: 'no-majority',
      yes: 1,
      no: 3,
    });
    expect(room.state.restVote).toBeUndefined();
    expect(seats).toHaveLength(4);
  });

  it('timer close wins before a late cast and the cast cannot append a second close', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 500;
    const { room, events, accounts, voteId } = setup(deadline);
    await connectAll(room, accounts);

    await vi.advanceTimersByTimeAsync(500);
    await room.castRestVote(accounts[3]!, voteId, 'no', 'ballot', randomUUID());

    const closes = events.filter((event) => event.type === 'RestVoteClosed');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.payload).toMatchObject({
      outcome: 'failed',
      closeReason: 'expired',
      yes: 1,
      no: 2,
    });
    expect(
      events.filter((event) => event.type === 'RestVoteCast'),
    ).toHaveLength(0);
  });

  it('pause freezes the wall-clock deadline and resume restores the remaining vote time', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 500;
    const { room, events, accounts, voteId } = setup(deadline);
    await connectAll(room, accounts);
    await room.setPaused(accounts[0]!, true, true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(room.state.restVote?.voteId).toBe(voteId);
    expect(room.state.restVote?.deadlineAt).toBeNull();
    expect(room.state.restVote?.remainingMs).toBe(500);

    await room.setPaused(accounts[0]!, false, true);
    await vi.advanceTimersByTimeAsync(499);
    expect(room.state.restVote?.voteId).toBe(voteId);
    await vi.advanceTimersByTimeAsync(1);
    expect(room.state.restVote).toBeUndefined();
    expect(
      events.find((event) => event.type === 'RestVoteClosed')?.payload,
    ).toMatchObject({ closeReason: 'expired' });
  });

  it('host tie-break is a separate single cast and closes without applying rest on no', async () => {
    vi.useFakeTimers();
    const { room, events, accounts, seats, voteId } = setup(Date.now() + 500);
    const state = structuredClone(room.state);
    state.restVote!.ballots = [
      { seat: seats[0]!.seatId, choice: 'yes' },
      { seat: seats[1]!.seatId, choice: 'no' },
      { seat: seats[2]!.seatId, choice: 'yes' },
      { seat: seats[3]!.seatId, choice: 'no' },
    ];
    state.restVote!.castSeatIds = seats.map((seat) => seat.seatId);
    room.state = state;
    await connectAll(room, accounts);

    await room.castRestVote(
      accounts[0]!,
      voteId,
      'no',
      'tiebreak',
      randomUUID(),
    );
    await room.castRestVote(
      accounts[0]!,
      voteId,
      'yes',
      'tiebreak',
      randomUUID(),
    );

    expect(
      events.filter((event) => event.type === 'RestVoteCast'),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === 'RestVoteClosed')?.payload,
    ).toMatchObject({
      outcome: 'failed',
      closeReason: 'host-tiebreak',
      yes: 2,
      no: 2,
    });
    expect(events.some((event) => event.type === 'RestApplied')).toBe(false);
  });

  it('combat start in the resolving DM turn cancels the open vote in that same commit', async () => {
    vi.useFakeTimers();
    const runner: SoloTurnRunner = {
      async run(request) {
        return {
          narration: 'Combat begins.',
          events: [
            { type: 'TurnStarted', turnId: randomUUID() },
            { type: 'CombatStarted', combatId: 'combat-1', entityIds: [] },
          ],
          state: request.state,
          turnSeed: '0x0000000000000001',
          usage: { in: 1, out: 1 },
        };
      },
    };
    const { room, events, accounts, voteId } = setup(
      Date.now() + 60_000,
      runner,
    );
    await connectAll(room, accounts);

    await room.submitAction(accounts[0]!, randomUUID(), 'The ambush starts.');
    await vi.advanceTimersByTimeAsync(10);

    const close = events.find((event) => event.type === 'RestVoteClosed');
    const combatStart = events.find((event) => event.type === 'CombatStarted');
    expect(close).toBeDefined();
    expect(combatStart).toBeDefined();
    expect(close!.seq).toBeLessThan(combatStart!.seq);
    expect(close!.payload).toMatchObject({
      voteId,
      outcome: 'failed',
      closeReason: 'cancelled-combat',
      yes: 0,
      no: 0,
    });
    expect(events.some((event) => event.type === 'RestApplied')).toBe(false);
    expect(room.state.restVote).toBeUndefined();
  });
});
