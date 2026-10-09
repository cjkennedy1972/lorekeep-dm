import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../src/room/Room.js';
import type { LatestState, StoredEvent } from '../src/persistence/index.js';
import type { RegistryEvent } from '../src/dm/memory.js';

const id = randomUUID();
const lease = {
  sessionId: id,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60000),
};
function fixture() {
  const events: StoredEvent[] = [];
  const registryWrites: RegistryEvent[][] = [];
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async persistRegistryEvents(_sessionId, registryEvents) {
      registryWrites.push([...registryEvents]);
    },
    async loadLatest() {
      return {
        snapshot,
        events: events.filter((event) => event.seq > (snapshot?.seq ?? 0)),
      };
    },
    async writeTurn(_sessionId, inputs, state) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const stored = inputs.map((input) => ({
        ...input,
        seq: events.length + 1,
        sessionId: id,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshot = {
        sessionId: id,
        seq: events.length,
        state,
        createdAt: new Date(),
      };
      return { events: stored };
    },
  };
  return { store, events, registryWrites, latest: () => store.loadLatest(id) };
}

describe('room actor', () => {
  it('serializes interleaved joins and broadcasts increasing presence seq', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const a: unknown[] = [];
    const b: unknown[] = [];
    await Promise.all([
      room.join(randomUUID(), { send: (message) => a.push(message) }),
      room.join(randomUUID(), { send: (message) => b.push(message) }),
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(
      a.filter(
        (message) => (message as { type: string }).type === 'PresenceChanged',
      ),
    ).toHaveLength(2);
    expect(
      b.filter(
        (message) => (message as { type: string }).type === 'PresenceChanged',
      ),
    ).toHaveLength(1);
    expect(room.state.seats).toHaveLength(2);
  });
  it('persists validated registry events through the room mailbox', async () => {
    const { store, registryWrites } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const registryEvent: RegistryEvent = {
      type: 'FlagSet',
      flag: { id: 'flag_gate_open', value: true },
    };
    await room.persistRegistry([registryEvent]);
    expect(registryWrites).toEqual([[registryEvent]]);
  });
  it('deduplicates actions and syncs only stale subscribers', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const action = randomUUID();
    expect(await room.submit(action)).toBe(true);
    expect(await room.submit(action)).toBe(false);
    expect(events).toHaveLength(1);
    const stale: unknown[] = [];
    const current: unknown[] = [];
    await room.subscribe(
      randomUUID(),
      { send: (message) => stale.push(message) },
      0,
    );
    await room.subscribe(
      randomUUID(),
      { send: (message) => current.push(message) },
      1,
    );
    expect(stale).toMatchObject([{ type: 'StateSync', seq: 1 }]);
    expect(current).toEqual([]);
  });
  it('rejects a missing lease and commands after drain', async () => {
    const { store } = fixture();
    expect(
      () =>
        new Room(
          store,
          { ...lease, expiresAt: new Date(0) },
          { snapshot: null, events: [] },
        ),
    ).toThrow(/lease/);
    const room = new Room(store, lease, { snapshot: null, events: [] });
    await room.drain();
    await expect(room.submit(randomUUID())).rejects.toThrow(/draining/);
  });
});
