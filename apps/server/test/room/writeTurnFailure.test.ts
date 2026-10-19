import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import { emptyRoom } from '../../src/room/reducer.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

function failingRoom() {
  const store = {
    async loadLatest() {
      throw new Error('reload unavailable');
    },
    async writeTurn() {
      throw new Error('disk full');
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  return new Room(store, lease, { snapshot: null, events: [] });
}

/** A store whose first write commits and then reports failure, like a lost ack. */
function ackLostRoom() {
  let head = { seq: 0, state: emptyRoom(sessionId) as unknown };
  let failNext = true;
  const commit = (seq: number, state: unknown) => {
    head = { seq, state };
    if (!failNext) return;
    failNext = false;
    throw new Error('ack lost');
  };
  const store = {
    async loadLatest() {
      return { snapshot: head.seq ? head : null, events: [] };
    },
    async writeTurn(
      _sessionId: string,
      events: { seq: number; turnId: string; type: string; payload: unknown }[],
      state: unknown,
    ) {
      const stored = events.map((e) => ({ sessionId, ...e, ts: new Date() }));
      commit(events.at(-1)!.seq, state);
      return { events: stored };
    },
    async writeHostTierCap(
      _sessionId: string,
      _cap: unknown,
      _lease: unknown,
      seq: number,
    ) {
      commit(seq, head.state);
      return [];
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  return new Room(store, lease, { snapshot: null, events: [] });
}

describe('room write failures', () => {
  it('surfaces the original write error from a direct writer when reload also fails', async () => {
    const room = failingRoom();
    await expect(room.persistGameState({ premise: 'x' })).rejects.toThrow(
      'disk full',
    );
  });

  it('surfaces the original write error from persist when reload also fails', async () => {
    const room = failingRoom();
    await expect(room.seat(randomUUID(), 'Owner', false)).rejects.toThrow(
      'disk full',
    );
  });

  it('rejects a retry of an action whose write committed before the error', async () => {
    const room = ackLostRoom();
    await expect(room.submit('action-1')).rejects.toThrow('ack lost');
    await expect(room.submit('action-1')).resolves.toBe(false);
  });

  it('reloads the committed seq when a host cap write commits before the error', async () => {
    const room = ackLostRoom();
    await expect(room.setHostTierCap('family')).rejects.toThrow('ack lost');
    expect(room.seq).toBe(1);
  });
});
