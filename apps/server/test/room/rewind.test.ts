import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TurnRevertedSchema, type ServerMessage } from '@game/schema';
import {
  NotTableHostError,
  Room,
  RewindRefusedError,
  type Connection,
  type RoomStore,
} from '../../src/room/Room.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type {
  LatestState,
  RewindPlan,
  StoredEvent,
} from '../../src/persistence/index.js';
import {
  findRewindTarget,
  ROOM_STATE_EVENT_TYPES,
} from '../../src/persistence/rewind.js';
import { joinSeated } from '../helpers/room.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
const recorder = (sent: ServerMessage[] = []): Connection => ({
  send(message) {
    sent.push(message as ServerMessage);
  },
});
const settle = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

function setup() {
  const events: StoredEvent[] = [];
  const snapshots: { seq: number; state: unknown }[] = [];
  const host = randomUUID();
  const latestSnapshot = (before: number) => {
    const snap = snapshots.filter((item) => item.seq < before).at(-1);
    return snap
      ? { sessionId, seq: snap.seq, state: snap.state, createdAt: new Date() }
      : null;
  };
  const store = {
    async loadLatest(): Promise<LatestState> {
      const snap = snapshots.at(-1);
      return {
        snapshot: snap
          ? {
              sessionId,
              seq: snap.seq,
              state: snap.state,
              createdAt: new Date(),
            }
          : null,
        events: events.filter((event) => event.seq > (snap?.seq ?? 0)),
      };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      snapshots.push({ seq: events.length, state: structuredClone(state) });
      return { events: stored };
    },
    async isTableHost(_id: string, accountId: string) {
      return accountId === host;
    },
    async loadRewindPlan(): Promise<RewindPlan | null> {
      const target = findRewindTarget(events);
      if (!target) return null;
      const snapshot = latestSnapshot(target.firstSeq);
      return {
        turnId: target.turnId,
        rewindUsed: target.rewindUsed,
        before: {
          snapshot,
          events: events.filter(
            (event) =>
              event.seq > (snapshot?.seq ?? 0) && event.seq < target.firstSeq,
          ),
        },
        retained: events.filter(
          (event) =>
            event.seq > target.firstSeq &&
            event.turnId !== target.turnId &&
            (ROOM_STATE_EVENT_TYPES as readonly string[]).includes(event.type),
        ),
        headSeq: events.length,
      };
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds;
    },
  } as unknown as RoomStore;
  const runner: SoloTurnRunner = {
    async run(_request, onEvent) {
      const n = ++turns;
      const turnId = `turn-${n}`;
      onEvent({ type: 'NarrationTier', tier: 'standard' });
      onEvent({ type: 'NarrationCompleted', narration: `narration ${n}` });
      return {
        narration: `narration ${n}`,
        events: [{ type: 'TurnStarted', turnId }],
        state: {
          map: { revision: n, cells: `cells-after-${n}` },
          lastNarration: `narration ${n}`,
          lastCombatBeat: `combat beat ${n}`,
        },
        turnSeed: '0x0000000000000001',
        usage: { in: 1, out: 1 },
      };
    },
  };
  let turns = 0;
  const room = new Room(store, lease, { snapshot: null, events: [] }, runner);
  return { room, events, host };
}

describe('rewind last resolved turn', () => {
  it('serializes an in-flight history query before a queued rewind commit', async () => {
    const { room, host: owner } = setup();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();

    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      historyStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    (room as unknown as { store: RoomStore }).store.loadNarrationHistory =
      async () => {
        historyStarted();
        await blocked;
        return [
          {
            turnId: 'turn-1',
            narration: 'narration 1',
            tier: 'standard',
          },
        ];
      };

    const sent: ServerMessage[] = [];
    const reconnecting = room.join(owner, recorder(sent), 'Owner', false, -1, {
      requireExistingSeat: true,
    });
    await started;
    const rewind = room.rewindLastTurn(owner);
    releaseHistory();
    await Promise.all([reconnecting, rewind]);

    const historyIndex = sent.findIndex(
      (message) => message.type === 'NarrationHistory',
    );
    const revertedIndex = sent.findIndex(
      (message) => message.type === 'TurnReverted',
    );
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(revertedIndex).toBeGreaterThan(historyIndex);
  });

  it('restores state, map and transcript, and emits TurnReverted', async () => {
    const { room, events, host: owner } = setup();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    const afterFirst = structuredClone(room.state.gameState);
    const firstSeq = room.seq;

    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();
    expect(room.state.gameState).toMatchObject({ map: { revision: 2 } });

    await room.rewindLastTurn(owner);

    expect(room.state.gameState).toEqual(afterFirst);
    expect(room.state.gameState).toMatchObject({
      lastCombatBeat: 'combat beat 1',
    });
    expect(room.seq).toBeGreaterThan(firstSeq);
    expect(room.seq).toBe(events.at(-1)?.seq);
    const reverted = events.filter((event) => event.type === 'TurnReverted');
    expect(reverted).toHaveLength(1);
    expect(TurnRevertedSchema.parse(reverted[0]!.payload)).toMatchObject({
      revertedTurnId: 'turn-2',
    });
    expect(
      events.filter((event) => event.turnId === 'turn-2'),
    ).not.toHaveLength(0);
    expect(findRewindTarget(events)?.turnId).toBe('turn-1');
  });

  it('keeps a seat joined after the reverted turn began', async () => {
    const { room, host: owner } = setup();
    const guest = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();
    await joinSeated(room, guest, recorder(), 'Guest');

    await room.rewindLastTurn(owner);

    expect(room.state.seats.map((seat) => seat.accountId)).toContain(guest);
    expect(room.state.gameState).toMatchObject({ map: { revision: 1 } });
  });

  it('keeps refusing an action id accepted after the reverted turn began', async () => {
    const { room, events, host: owner } = setup();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();
    events.push({
      sessionId,
      seq: events.length + 1,
      turnId: randomUUID(),
      type: 'ActionAccepted',
      payload: { actionId: 'queued-action' },
      ts: new Date(),
    });

    await room.rewindLastTurn(owner);

    expect(await room.submit('queued-action')).toBe(false);
  });

  it('tells connected clients to retract the reverted turn', async () => {
    const { room, host: owner } = setup();
    const sent: ServerMessage[] = [];
    await joinSeated(
      room,
      owner,
      { send: (message) => sent.push(message) },
      'Owner',
    );
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();

    await room.rewindLastTurn(owner);

    expect(sent.filter((message) => message.type === 'TurnReverted')).toEqual([
      expect.objectContaining({
        type: 'TurnReverted',
        payload: { revertedTurnId: 'turn-2' },
      }),
    ]);
  });

  it('refuses a second rewind of the same turn', async () => {
    const { room, events, host: owner } = setup();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();

    await room.rewindLastTurn(owner);
    const count = events.length;

    await expect(room.rewindLastTurn(owner)).rejects.toThrow(
      RewindRefusedError,
    );
    expect(events).toHaveLength(count);
  });

  it('allows a rewind again after a new turn resolves', async () => {
    const { room, events, host: owner } = setup();
    await joinSeated(room, owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Search the room.', 'Owner');
    await settle();
    await room.rewindLastTurn(owner);

    await room.submitAction(owner, randomUUID(), 'Climb the wall.', 'Owner');
    await settle();
    await room.rewindLastTurn(owner);

    expect(
      events
        .filter((event) => event.type === 'TurnReverted')
        .map(
          (event) =>
            (event.payload as { revertedTurnId: string }).revertedTurnId,
        ),
    ).toEqual(['turn-2', 'turn-3']);
  });

  it('refuses rewind from anyone but the table host', async () => {
    const { room, events, host: owner } = setup();
    const guest = randomUUID();
    await joinSeated(room, owner, recorder(), 'Owner');
    await joinSeated(room, guest, recorder(), 'Guest');
    await room.submitAction(owner, randomUUID(), 'Open the door.', 'Owner');
    await settle();

    await expect(room.rewindLastTurn(guest)).rejects.toThrow(NotTableHostError);
    expect(events.some((event) => event.type === 'TurnReverted')).toBe(false);
  });
});
