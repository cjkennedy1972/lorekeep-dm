import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
function setup(runner: SoloTurnRunner) {
  const events: StoredEvent[] = [];
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async loadLatest() {
      return { snapshot, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshot = {
        sessionId,
        seq: events.length,
        state,
        createdAt: new Date(),
      };
      return { events: stored };
    },
  };
  return {
    room: new Room(store, lease, { snapshot: null, events: [] }, runner),
    events,
    latestSnapshot: () => snapshot,
  };
}
const result = {
  narration: 'A quiet result.',
  events: [
    { type: 'TurnStarted', turnId: 't1' },
    { type: 'RollEvent', total: 16 },
  ],
  state: {},
  turnSeed: '0x0000000000000001',
  usage: { in: 1, out: 1 },
};

describe('Room solo DM turn lifecycle', () => {
  it('streams a check before narration, ignores duplicate ids and persists the committed result', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner: SoloTurnRunner = {
      async run(_request, emit) {
        emit({ type: 'RollEvent', turnId: 't1', total: 16 });
        emit({
          type: 'NarrationChunk',
          turnId: 't1',
          text: 'A quiet ',
          index: 0,
        });
        emit({
          type: 'NarrationCompleted',
          turnId: 't1',
          text: 'A quiet result.',
          words: 3,
        });
        await gate;
        return result as never;
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as { type: string }),
    });
    const actionId = randomUUID();
    expect(
      await room.submitAction(accountId, actionId, 'I check the seal.'),
    ).toBe(true);
    expect(
      await room.submitAction(accountId, actionId, 'I check the seal.'),
    ).toBe(false);
    expect(
      messages.findIndex((message) => message.type === 'RollEvent'),
    ).toBeLessThan(
      messages.findIndex((message) => message.type === 'NarrationChunk'),
    );
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.map((event) => event.type)).toEqual([
      'SeatJoined',
      'PresenceChanged',
      'RollEvent',
      'NarrationCompleted',
      'ActionAccepted',
      'GameStateCommitted',
    ]);
    expect(latestSnapshot()?.state).toMatchObject({ actionIds: [actionId] });
  });

  it('rejects actions beyond the per-seat in-flight queue cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: SoloTurnRunner = {
      async run() {
        await gate;
        return result as never;
      },
    };
    const { room } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: { code?: string } }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    expect(await room.submitAction(accountId, randomUUID(), 'one')).toBe(true);
    expect(await room.submitAction(accountId, randomUUID(), 'two')).toBe(true);
    expect(await room.submitAction(accountId, randomUUID(), 'three')).toBe(
      true,
    );
    expect(await room.submitAction(accountId, randomUUID(), 'four')).toBe(
      false,
    );
    expect(
      messages.some(
        (message) =>
          message.type === 'Error' &&
          message.payload?.code === 'ACTION_REJECTED',
      ),
    ).toBe(true);
    release();
  });

  it('allows a later retry after an endpoint failure without persisting action state', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        return { ...result, fallback: 'endpoint-error' } as never;
      },
    };
    const { room, events, latestSnapshot } = setup(runner);
    const accountId = randomUUID();
    await room.join(accountId, { send() {} });
    const actionId = randomUUID();
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      (latestSnapshot()?.state as { actionIds?: string[] } | undefined)
        ?.actionIds,
    ).toEqual([]);
    expect(await room.submitAction(accountId, actionId, 'I look around.')).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it('tells the player when a turn throws and allows the same action to be retried', async () => {
    let calls = 0;
    const runner: SoloTurnRunner = {
      async run() {
        calls++;
        if (calls === 1) throw new Error('internal detail that must not leak');
        return result as never;
      },
    };
    const { room, events } = setup(runner);
    const accountId = randomUUID();
    const messages: { type: string; payload?: Record<string, unknown> }[] = [];
    await room.join(accountId, {
      send: (message) => messages.push(message as (typeof messages)[number]),
    });
    const actionId = randomUUID();
    expect(
      await room.submitAction(accountId, actionId, 'I try the latch.'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failure = messages.find((message) => message.type === 'Error');
    expect(failure?.payload).toMatchObject({ code: 'TURN_FAILED', actionId });
    expect(JSON.stringify(failure)).not.toContain('internal detail');
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(false);
    expect(
      await room.submitAction(accountId, actionId, 'I try the latch.'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === 'ActionAccepted')).toBe(true);
    expect(calls).toBe(2);
  });
});
