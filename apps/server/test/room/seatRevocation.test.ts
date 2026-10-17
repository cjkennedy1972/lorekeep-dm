import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type Connection, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRequest, SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import { joinSeated } from '../helpers/room.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

const recorder = (): Connection => ({ send() {} });

const settle = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

function setup(requests: SoloTurnRequest[], firstTurnGate?: Promise<void>) {
  const events: StoredEvent[] = [];
  const store = {
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id: string, inputs: StoredEvent[]) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      return { events: stored };
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  const runner: SoloTurnRunner = {
    async run(request, onEvent) {
      requests.push(request);
      if (requests.length === 1 && firstTurnGate) await firstTurnGate;
      onEvent({ type: 'NarrationTier', tier: 'standard' });
      onEvent({ type: 'NarrationCompleted', narration: 'ok' });
      return {
        narration: 'ok',
        events: [{ type: 'TurnStarted', turnId: 't1' }],
        state: { lastNarration: 'ok', lastPlayerText: request.text },
        turnSeed: '0x0000000000000001',
        usage: { in: 1, out: 1 },
      };
    },
  };
  return new Room(store, lease, { snapshot: null, events: [] }, runner);
}

describe('seat revocation and the action queue', () => {
  it('a queued action from a player who left is never resolved on drain', async () => {
    const requests: SoloTurnRequest[] = [];
    const room = setup(requests);
    const owner = randomUUID();
    const leaver = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await joinSeated(room, leaver, recorder(), 'Leaver');

    await room.setPaused(owner, true, true);
    await room.submitAction(leaver, randomUUID(), 'Pick the lock.', 'Leaver');
    await room.leave(leaver);
    await room.setPaused(owner, false, true);
    await settle();

    expect(requests).toHaveLength(0);
    expect(room.state.seats.map((seat) => seat.accountId)).toEqual([owner]);
  });

  it('leaving does not abort another player’s in-flight turn', async () => {
    const requests: SoloTurnRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const room = setup(requests, gate);
    const owner = randomUUID();
    const leaver = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await joinSeated(room, leaver, recorder(), 'Leaver');

    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(leaver, randomUUID(), 'Pick the lock.', 'Leaver');
    await room.leave(leaver);
    release();
    await settle();

    expect(requests.map((request) => request.text)).toEqual(['Open the door.']);
    expect(requests[0]!.signal.aborted).toBe(false);
  });

  it('leaving aborts the leaver’s own in-flight turn', async () => {
    const requests: SoloTurnRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const room = setup(requests, gate);
    const owner = randomUUID();
    const leaver = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await joinSeated(room, leaver, recorder(), 'Leaver');

    await room.submitAction(leaver, randomUUID(), 'Pick the lock.', 'Leaver');
    await settle();
    await room.leave(leaver);
    release();
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
  });
});
