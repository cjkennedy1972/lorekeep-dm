import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../src/room/Room.js';
import { recoverRoom } from '../src/room/recovery.js';
import type { StoredEvent } from '../src/persistence/index.js';

const id = randomUUID();
const lease = {
  sessionId: id,
  nodeId: 'node',
  epoch: 2,
  expiresAt: new Date(Date.now() + 60000),
};
const seat = {
  seatId: randomUUID(),
  accountId: randomUUID(),
  displayName: 'Player',
  presence: 'offline',
};
const event = (seq: number, type: string, payload: unknown): StoredEvent => ({
  sessionId: id,
  seq,
  turnId: randomUUID(),
  type,
  payload,
  ts: new Date(),
});

describe('room recovery', () => {
  it('replays a full log and a snapshot plus tail to identical state', () => {
    const events = [
      event(1, 'SeatJoined', seat),
      event(2, 'PresenceChanged', { seatId: seat.seatId, presence: 'online' }),
    ];
    const full = recoverRoom(id, { snapshot: null, events });
    const fromSnapshot = recoverRoom(id, {
      snapshot: {
        sessionId: id,
        seq: 1,
        state: recoverRoom(id, { snapshot: null, events: events.slice(0, 1) })
          .state,
        createdAt: new Date(),
      },
      events: events.slice(1),
    });
    const snapshotOnly = recoverRoom(id, {
      snapshot: {
        sessionId: id,
        seq: 2,
        state: full.state,
        createdAt: new Date(),
      },
      events: [],
    });
    expect(fromSnapshot).toEqual(full);
    expect(snapshotOnly).toEqual(full);
  });
  it('rehydrates dedupe and sends recovered seq on reconnect', async () => {
    const actionId = randomUUID();
    const snapshot = {
      sessionId: id,
      seq: 1,
      state: {
        sessionId: id,
        phase: 'lobby',
        seats: [],
        actionIds: [actionId],
      },
      createdAt: new Date(),
    };
    const store = {
      loadLatest: async () => ({ snapshot, events: [] }),
      writeTurn: async () => {
        throw new Error('unexpected write');
      },
    } as RoomStore;
    const room = new Room(store, lease, await store.loadLatest(id));
    const sent: unknown[] = [];
    await room.subscribe(
      randomUUID(),
      { send: (message) => sent.push(message) },
      0,
    );
    expect(sent).toMatchObject([{ type: 'StateSync', seq: 1 }]);
    expect(await room.submit(actionId)).toBe(false);
  });
});

describe('graceful drain', () => {
  it('handles SIGTERM, releases leases, and exits zero', async () => {
    const { installGracefulDrain } = await import('../src/room/drain.js');
    const { vi } = await import('vitest');
    const drain = vi.fn(async () => {});
    const exit = vi.fn();
    const uninstall = installGracefulDrain(async () => drain(), exit);
    try {
      process.emit('SIGTERM');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(drain).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });
});
