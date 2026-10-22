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
    const accountA = randomUUID();
    const accountB = randomUUID();
    await room.seat(accountA, 'A');
    await room.seat(accountB, 'B');
    await Promise.all([
      room.join(accountA, { send: (message) => a.push(message) }),
      room.join(accountB, { send: (message) => b.push(message) }),
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
  it('leave revokes the seat and closes the socket; disconnect only marks offline', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const stayer = randomUUID();
    const leaver = randomUUID();
    const closes: unknown[] = [];
    await room.seat(stayer, 'Stayer');
    await room.seat(leaver, 'Leaver');
    await room.join(stayer, { send: () => {} });
    await room.join(leaver, {
      send: () => {},
      close: (...args: unknown[]) => closes.push(args),
    });
    await room.disconnect(stayer);
    expect(events.at(-1)?.type).toBe('PresenceChanged');
    expect(room.state.seats).toHaveLength(2);

    await room.leave(leaver);
    expect(events.at(-1)?.type).toBe('SeatRevoked');
    expect(room.state.seats.map((seat) => seat.accountId)).toEqual([stayer]);
    expect(closes).toEqual([[1000, 'Left the table']]);

    await expect(
      room.join(leaver, { send: () => {} }, 'Leaver', false, -1, {
        requireExistingSeat: true,
      }),
    ).rejects.toThrow('Player is not seated at this table');
    await room.seat(leaver, 'Leaver');
    await room.join(leaver, { send: () => {} });
    expect(room.state.seats.map((seat) => seat.accountId)).toContain(leaver);
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
  it('edits a queued submission without moving its receipt position and scopes it to its seat', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return new Promise(() => {});
      },
    });
    const accountA = randomUUID();
    const accountB = randomUUID();
    await room.seat(accountA, 'A');
    await room.seat(accountB, 'B');
    await room.persistGameState({});
    const first = randomUUID();
    await room.submitAction(accountA, first, 'first');

    expect(
      await room.editAction(accountB, randomUUID(), first, 'cross-seat'),
    ).toBe('unknown_submission');
    const editId = randomUUID();
    expect(await room.editAction(accountA, editId, first, 'revised')).toBe(
      'edited',
    );
    expect(
      await room.editAction(accountA, editId, first, 'changed again'),
    ).toBe('duplicate');
    const edit = events.find((event) => event.type === 'RoundActionEdited');
    expect(edit?.payload).toMatchObject({
      submission: {
        actionId: editId,
        originalActionId: first,
        text: 'revised',
        receiptSeq: 1,
      },
    });
    expect(
      events.filter((event) => event.type === 'RoundActionEdited'),
    ).toHaveLength(1);
  });
  it('resolves one receipt-ordered batch even when gate decisions arrive out of order', async () => {
    const { store, events } = fixture();
    const requests: { text: string }[] = [];
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run(request) {
        requests.push({ text: request.text });
        return {
          narration: 'The party acts.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const accountA = randomUUID();
    const accountB = randomUUID();
    await room.seat(accountA, 'A');
    await room.seat(accountB, 'B');
    await room.persistGameState({});
    expect(
      await room.submitAction(
        accountA,
        randomUUID(),
        'first by receipt',
        'A',
        22,
      ),
    ).toBe(true);
    expect(
      await room.submitAction(
        accountB,
        randomUUID(),
        'second by receipt',
        'B',
        11,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      events.filter((event) => event.type === 'RoundResolved'),
    ).toHaveLength(1);
    expect(requests).toEqual([
      { text: 'B: second by receipt\n\nA: first by receipt' },
    ]);
    const resolved = events.filter((event) => event.type === 'RoundResolved');
    expect(resolved).toHaveLength(1);
    expect(
      (
        resolved[0]?.payload as { actions: { receiptSeq: number }[] }
      ).actions.map((action) => action.receiptSeq),
    ).toEqual([11, 22]);
    expect(room.state.round?.status).toBe('open');
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
  it('gives a checkpoint retry the combat seed that combat rolls read', async () => {
    const { store } = fixture();
    const room = new Room(store, lease, { snapshot: null, events: [] });
    const accountId = randomUUID();
    await room.seat(accountId, 'Aria');
    await room.persistGameState({
      checkpoint: { combatRoom: { seed: 1111, ended: false } },
      combatRoom: { seed: 2222, ended: true },
      retrySeed: 2222,
    });
    await room.chooseTpkResolution(accountId, 'retry-checkpoint');
    const gameState = room.state.gameState as {
      retrySeed: number;
      combatRoom: { seed: number };
    };
    expect(gameState.combatRoom.seed).toBe(gameState.retrySeed);
    expect(gameState.combatRoom.seed).not.toBe(1111);
  });
});
