import { randomUUID } from 'node:crypto';
import { StateSyncSchema } from '@game/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  Room,
  nextLateJoinBoundary,
  type RoomStore,
} from '../src/room/Room.js';
import type { LatestState, StoredEvent } from '../src/persistence/index.js';
import type { RegistryEvent } from '../src/dm/memory.js';
import type { SoloTurnRunner } from '../src/room/dmTurn.js';

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
  const inactiveAccounts = new Set<string>();
  let snapshot: LatestState['snapshot'] = null;
  const store: RoomStore = {
    async isAccountActive(accountId) {
      return !inactiveAccounts.has(accountId);
    },
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
  return {
    store,
    events,
    registryWrites,
    inactiveAccounts,
    latest: () => store.loadLatest(id),
  };
}

describe('room actor', () => {
  it('includes a complete public round snapshot in StateSync', async () => {
    const { store } = fixture();
    const accountId = randomUUID();
    const seatId = randomUUID();
    const actionId = randomUUID();
    const roundId = randomUUID();
    const room = new Room(store, lease, {
      snapshot: {
        sessionId: id,
        seq: 1,
        createdAt: new Date(),
        state: {
          sessionId: id,
          phase: 'lobby',
          seats: [
            { seatId, accountId, displayName: 'Player', presence: 'offline' },
          ],
          gameState: {},
          round: {
            roundId,
            status: 'open',
            eligibleSeatIds: [seatId],
            deadlineAt: Date.now() + 30_000,
            submissions: [
              {
                seatId,
                accountId,
                actionId,
                originalActionId: actionId,
                actionIds: [actionId],
                text: 'private action text',
                playerName: 'Player',
                receiptSeq: 2,
              },
            ],
            queuedSubmissions: [],
          },
        },
      },
      events: [],
    });
    const sent: unknown[] = [];
    await room.subscribe(accountId, { send: (message) => sent.push(message) });
    const sync = sent.find(
      (message) => (message as { type?: string }).type === 'StateSync',
    ) as {
      payload: { state: unknown; round?: Record<string, unknown> };
    };
    expect(StateSyncSchema.parse(sync).payload.round).toBeDefined();
    expect(sync.payload.round).toMatchObject({
      roundId,
      status: 'open',
      eligibleSeatIds: [seatId],
      submissions: [
        { seatId, actionId, actionIds: [actionId], playerName: 'Player' },
      ],
      queuedSubmissions: [],
    });
    expect(sync.payload.round).not.toHaveProperty('submissions.0.text');
    expect(JSON.stringify(sync)).not.toContain('private action text');
  });

  it('places exploration admission at a committed scene or resolved-round boundary and combat admission at a round boundary', () => {
    expect(
      nextLateJoinBoundary({
        turnInFlight: true,
        combatActive: false,
        roundStatus: 'resolved',
      }),
    ).toBe('after-turn');
    expect(
      nextLateJoinBoundary({
        turnInFlight: false,
        combatActive: true,
        roundStatus: 'resolved',
      }),
    ).toBe('next-combat-round');
    expect(
      nextLateJoinBoundary({
        turnInFlight: false,
        combatActive: false,
        roundStatus: 'resolved',
        sceneBoundary: false,
      }),
    ).toBe('before-next-turn');
    expect(
      nextLateJoinBoundary({
        turnInFlight: false,
        combatActive: false,
        roundStatus: 'open',
        sceneBoundary: false,
      }),
    ).toBe('after-turn');
    expect(
      nextLateJoinBoundary({
        turnInFlight: false,
        combatActive: false,
        roundStatus: 'resolved',
        sceneBoundary: true,
      }),
    ).toBe('before-next-turn');
  });

  it('suppresses disconnect and reconnect events for a sub-10-second blip', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const accountId = randomUUID();
    await room.seat(accountId, 'Player');
    await room.join(accountId, { send() {} });
    const seatId = room.state.seats[0]!.seatId;
    vi.useFakeTimers();
    try {
      const disconnected = room.disconnect(accountId);
      await vi.advanceTimersByTimeAsync(10);
      await disconnected;
      await vi.advanceTimersByTimeAsync(5_000);
      const rejoined = room.join(accountId, { send() {} });
      await vi.advanceTimersByTimeAsync(10);
      await rejoined;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(room.state.seats[0]?.presence).toBe('connected');
      expect(
        events.filter(
          (event) =>
            ['SeatDisconnected', 'SeatReconnected'].includes(event.type) &&
            (event.payload as { seatId?: string }).seatId === seatId,
        ),
      ).toHaveLength(0);
    } finally {
      await room.drain();
      vi.useRealTimers();
    }
  });

  it('persists SeatTakenOver immediately during the presence coalescing window', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const accountId = randomUUID();
    await room.seat(accountId, 'Player');
    await room.join(accountId, { send() {} });
    const seatId = room.state.seats[0]!.seatId;
    vi.useFakeTimers();
    try {
      const disconnected = room.disconnect(accountId);
      await vi.advanceTimersByTimeAsync(2);
      await disconnected;
      expect(events.some((event) => event.type === 'SeatDisconnected')).toBe(
        false,
      );

      const takeover = room.recordSeatTakenOver(seatId);
      await vi.advanceTimersByTimeAsync(2);
      await takeover;
      expect(
        events.filter((event) => event.type === 'SeatTakenOver'),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === 'SeatDisconnected')).toBe(
        false,
      );
    } finally {
      await room.drain();
      vi.useRealTimers();
    }
  });

  it('moves through disconnected, returning, and connected; only confirmed absence pauses the table', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const accountId = randomUUID();
    await room.seat(accountId, 'Player');
    await room.join(accountId, { send() {} });
    expect(room.state.seats[0]?.presence).toBe('connected');

    vi.useFakeTimers();
    try {
      const disconnected = room.disconnect(accountId);
      await vi.advanceTimersByTimeAsync(10);
      await disconnected;
      expect(room.state.seats[0]?.presence).toBe('disconnected');
      expect(
        events.filter(
          (event) =>
            [
              'PresenceChanged',
              'SeatDisconnected',
              'SeatAway',
              'SeatReconnected',
            ].includes(event.type) &&
            (event.payload as { seatId?: string }).seatId ===
              room.state.seats[0]?.seatId,
        ),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === 'SeatDisconnected')).toBe(
        false,
      );
      expect(room.state).toMatchObject({
        paused: true,
        pauseCause: 'no-connected-seats',
      });
      await vi.advanceTimersByTimeAsync(9_990);
      await vi.advanceTimersByTimeAsync(2);
      expect(events.some((event) => event.type === 'SeatDisconnected')).toBe(
        true,
      );
      expect(
        events.filter(
          (event) =>
            [
              'PresenceChanged',
              'SeatDisconnected',
              'SeatAway',
              'SeatReconnected',
            ].includes(event.type) &&
            (event.payload as { seatId?: string }).seatId ===
              room.state.seats[0]?.seatId,
        ),
      ).toHaveLength(2);

      const rejoined = room.join(accountId, { send() {} });
      await vi.advanceTimersByTimeAsync(10);
      await rejoined;
      expect(room.state.seats[0]?.presence).toBe('returning');

      await vi.advanceTimersByTimeAsync(10_010);
      expect(room.state.seats[0]?.presence).toBe('connected');
      expect(room.state).toMatchObject({ paused: false });
      expect(events.some((event) => event.type === 'SeatAway')).toBe(false);
    } finally {
      await room.drain();
      vi.useRealTimers();
    }
  });

  it('requires host approval for a lost-token claim and expires it after 60 seconds', async () => {
    const { store } = fixture();
    const host = randomUUID();
    const claimant = randomUUID();
    store.isTableHost = async (_sessionId, accountId) => accountId === host;
    const room = new Room(store, lease, await store.loadLatest(id));
    await room.seat(host, 'Host');
    await room.seat(claimant, 'Claimant');
    vi.useFakeTimers();
    try {
      const claimId = randomUUID();
      const decision = room.requestSeatResumeClaim(claimant, claimId);
      await vi.advanceTimersByTimeAsync(59_999);
      await room.approveSeatResumeClaim(host, randomUUID(), claimId);
      await expect(decision).resolves.toBe(true);

      const expiredId = randomUUID();
      const expired = room.requestSeatResumeClaim(claimant, expiredId);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(expired).resolves.toBe(false);
      await expect(
        room.approveSeatResumeClaim(host, randomUUID(), expiredId),
      ).rejects.toThrow();
    } finally {
      await room.drain();
      vi.useRealTimers();
    }
  });

  it('retains a revoked seat in Room state while removing active control membership', async () => {
    const { store } = fixture();
    const host = randomUUID();
    const target = randomUUID();
    store.isTableHost = async (_sessionId, accountId) => accountId === host;
    const room = new Room(store, lease, await store.loadLatest(id));
    await room.seat(host, 'Host');
    await room.seat(target, 'Target');
    const revoked = room.state.seats.find((seat) => seat.accountId === target)!;
    await room.leave(target);
    expect(room.state.seats.some((seat) => seat.accountId === target)).toBe(
      false,
    );
    expect(room.state.revokedSeats).toContainEqual({
      ...revoked,
      presence: 'revoked',
    });
    await room.drain();
  });

  describe('host controls', () => {
    it('requires a current host and enforces timer bounds server-side', async () => {
      const { store } = fixture();
      const owner = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === owner;
      const room = new Room(store, lease, await store.loadLatest(id));
      const player = randomUUID();
      await room.seat(owner, 'Host');
      await room.seat(player, 'Player');
      const hostSeat = room.state.seats.find(
        (seat) => seat.accountId === owner,
      )!;
      await expect(
        room.kickSeat(player, randomUUID(), hostSeat.seatId),
      ).rejects.toThrow('Only the table host');
      await expect(
        room.transferHost(player, randomUUID(), hostSeat.seatId),
      ).rejects.toThrow('Only the table host');
      await expect(
        room.approveLateJoin(player, randomUUID(), randomUUID()),
      ).rejects.toThrow('Only the table host');
      await expect(
        room.denyLateJoin(player, randomUUID(), randomUUID()),
      ).rejects.toThrow('Only the table host');
      await expect(room.endTable(player, randomUUID())).rejects.toThrow(
        'Only the table host',
      );
      await expect(
        room.setChatMute(player, randomUUID(), hostSeat.seatId, true),
      ).rejects.toThrow('Only the table host');
      await expect(room.configureRoundTimer(player, 30_000)).rejects.toThrow(
        'Only the table host',
      );
      await expect(room.configureRoundTimer(owner, 29_999)).rejects.toThrow(
        '30 and 600 seconds',
      );
      await expect(room.configureRoundTimer(owner, 600_001)).rejects.toThrow(
        '30 and 600 seconds',
      );
      await room.configureRoundTimer(owner, null);
      await room.configureRoundTimer(owner, 30_000);
    });

    it('kicks a current seat with actor attribution and preserves transfer, mute, and end state on replay', async () => {
      const { store, events, latest } = fixture();
      let owner = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === owner;
      store.transferTableHost = async (_sessionId, current, next) => {
        if (current !== owner) throw new Error('not owner');
        owner = next;
      };
      store.endTable = async () => {};
      const room = new Room(store, lease, await store.loadLatest(id));
      const host = owner;
      const target = randomUUID();
      await room.seat(host, 'Host');
      await room.seat(target, 'Target');
      const hostSeat = room.state.seats.find(
        (seat) => seat.accountId === host,
      )!;
      const targetSeat = room.state.seats.find(
        (seat) => seat.accountId === target,
      )!;
      await room.kickSeat(
        host,
        '00000000-0000-4000-8000-000000000001',
        targetSeat.seatId,
      );
      expect(events.at(-1)).toMatchObject({
        type: 'SeatRevoked',
        payload: {
          seatId: targetSeat.seatId,
          actorSeatId: hostSeat.seatId,
          actorAccountId: host,
          cause: 'host-kick',
        },
      });
      await room.kickSeat(
        host,
        '00000000-0000-4000-8000-000000000001',
        targetSeat.seatId,
      );

      const replacement = randomUUID();
      await room.seat(replacement, 'Replacement');
      await room.setChatMute(
        host,
        '00000000-0000-4000-8000-000000000002',
        room.state.seats.find((seat) => seat.accountId === replacement)!.seatId,
        true,
      );
      await room.transferHost(
        host,
        '00000000-0000-4000-8000-000000000003',
        room.state.seats.find((seat) => seat.accountId === replacement)!.seatId,
      );
      expect(
        room.state.seats.find((seat) => seat.accountId === replacement),
      ).toMatchObject({ isHost: true, chatMuted: true });
      const restored = new Room(store, lease, await latest());
      expect(
        restored.state.seats.find((seat) => seat.accountId === replacement),
      ).toMatchObject({ isHost: true, chatMuted: true });
      await restored.endTable(
        replacement,
        '00000000-0000-4000-8000-000000000004',
      );
      await restored.endTable(
        replacement,
        '00000000-0000-4000-8000-000000000004',
      );
      expect(restored.state.ended).toBe(true);
      expect(new Room(store, lease, await latest()).state.ended).toBe(true);
    });

    it('does not persist TableEnded when the table store refuses to end it', async () => {
      const { store, events } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      store.endTable = async () => {
        throw new Error('store unavailable');
      };
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');

      await expect(room.endTable(host, randomUUID())).rejects.toThrow(
        'store unavailable',
      );
      expect(room.state.ended).not.toBe(true);
      expect(events.some((event) => event.type === 'TableEnded')).toBe(false);
    });

    it('approves a late join when persisted combat state has no tracker', async () => {
      const { store } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.persistGameState({
        combatRoom: { entities: [], map: { w: 1, h: 1, cells: [] } },
      });
      const requestId = await room.requestLateJoin(randomUUID(), 'Late');

      await expect(
        room.approveLateJoin(host, randomUUID(), requestId),
      ).resolves.toBeUndefined();
    });

    it('does not admit an approved late join after their account becomes inactive', async () => {
      const { store, events, inactiveAccounts } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.persistGameState({});
      const requester = randomUUID();
      const requestId = await room.requestLateJoin(requester, 'Late');
      await room.approveLateJoin(host, randomUUID(), requestId);
      inactiveAccounts.add(requester);

      await room.resolveNow(host);

      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinAdmitted',
      );
    });

    it('admits approved exploration joiners at a committed scene boundary', async () => {
      const { store, events } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const runner: SoloTurnRunner = {
        async run(request) {
          return {
            narration: 'The scene closes.',
            events: [
              { type: 'TurnStarted', turnId: 'turn-scene-close' },
              { type: 'SceneClosed', sceneId: 'scene-test', summary: 'Done.' },
            ],
            state: request.state as Record<string, unknown>,
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
          };
        },
      };
      const room = new Room(store, lease, await store.loadLatest(id), runner);
      await room.seat(host, 'Host');
      await room.persistGameState({});
      const requester = randomUUID();
      const requestId = await room.requestLateJoin(requester, 'Late');
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      await room.approveLateJoin(host, randomUUID(), requestId);
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      await room.submitAction(host, randomUUID(), 'close the scene');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(true);
      expect(events.map((event) => event.type)).toContain('LateJoinApproved');
      expect(events.map((event) => event.type)).toContain('LateJoinAdmitted');
    });
  });

  it('preserves the frozen action when editing and withdrawing queued actions during resolution', async () => {
    const { store } = fixture();
    let startTurn!: () => void;
    let finishTurn!: () => void;
    const started = new Promise<void>((resolve) => (startTurn = resolve));
    const hold = new Promise<void>((resolve) => (finishTurn = resolve));
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        startTurn();
        await hold;
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    const executedAction = randomUUID();
    const queuedAction = randomUUID();
    const editedQueuedAction = randomUUID();
    await room.submitAction(host, executedAction, 'Executed action', 'Host');
    await started;
    await room.submitAction(host, queuedAction, 'Queued action', 'Host');
    expect(
      await room.editAction(
        host,
        editedQueuedAction,
        queuedAction,
        'Edited queued action',
      ),
    ).toBe('edited');
    expect(room.state.round?.submissions).toMatchObject([
      { actionId: executedAction, text: 'Executed action' },
    ]);
    const withdrawActionId = randomUUID();
    expect(
      await room.withdrawRoundAction(
        host,
        withdrawActionId,
        editedQueuedAction,
      ),
    ).toBe('withdrawn');
    expect(
      await room.withdrawRoundAction(
        host,
        withdrawActionId,
        editedQueuedAction,
      ),
    ).toBe('duplicate');
    expect(
      room.state.round?.submissions.map((item) => item.actionId),
    ).toContain(executedAction);
    finishTurn();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (
        room.state.round?.status === 'open' &&
        room.state.round.submissions.length === 0 &&
        room.state.round.queuedSubmissions.length === 0
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await room.submitAction(host, executedAction, 'Retry', 'Host')).toBe(
      false,
    );
    await room.drain(100);
  });
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
  it('does not allow a left account to resubscribe or receive later broadcasts', async () => {
    const { store } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const leaver = randomUUID();
    const sent: unknown[] = [];
    const closes: unknown[] = [];
    await room.seat(leaver, 'Leaver');
    await room.subscribe(leaver, {
      send: (message) => sent.push(message),
      close: (...args: unknown[]) => closes.push(args),
    });

    await room.leave(leaver);
    sent.length = 0;
    await room.subscribe(leaver, {
      send: (message) => sent.push(message),
      close: (...args: unknown[]) => closes.push(args),
    });
    await room.seat(randomUUID(), 'Another player');

    expect(sent).toEqual([]);
    expect(closes).toContainEqual([1000, 'Left the table']);
    expect(closes).toContainEqual([1008, 'Seat required to subscribe']);
  });
  it('does not allow a kicked account to resubscribe or receive later broadcasts', async () => {
    const { store } = fixture();
    const host = randomUUID();
    store.isTableHost = async (_sessionId, accountId) => accountId === host;
    const room = new Room(store, lease, await store.loadLatest(id));
    const target = randomUUID();
    const sent: unknown[] = [];
    const closes: unknown[] = [];
    await room.seat(host, 'Host');
    await room.seat(target, 'Target');
    await room.subscribe(target, {
      send: (message) => sent.push(message),
      close: (...args: unknown[]) => closes.push(args),
    });
    const targetSeat = room.state.seats.find(
      (seat) => seat.accountId === target,
    )!;

    await room.kickSeat(host, randomUUID(), targetSeat.seatId);
    sent.length = 0;
    await room.subscribe(target, {
      send: (message) => sent.push(message),
      close: (...args: unknown[]) => closes.push(args),
    });
    await room.seat(randomUUID(), 'Another player');

    expect(sent).toEqual([]);
    expect(closes).toContainEqual([1008, 'Seat revoked by the host']);
    expect(closes).toContainEqual([1008, 'Seat required to subscribe']);
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
    const staleAccount = randomUUID();
    const currentAccount = randomUUID();
    await room.seat(staleAccount, 'Stale');
    await room.seat(currentAccount, 'Current');
    await room.subscribe(staleAccount, {
      send: (message) => stale.push(message),
    });
    await room.subscribe(currentAccount, {
      send: (message) => current.push(message),
    });
    stale.length = 0;
    current.length = 0;
    const currentSeq = room.seq;
    await room.subscribe(
      staleAccount,
      { send: (message) => stale.push(message) },
      0,
    );
    await room.subscribe(
      currentAccount,
      { send: (message) => current.push(message) },
      currentSeq,
    );
    expect(stale).toMatchObject([{ type: 'StateSync', seq: currentSeq }]);
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
  it('scopes party action idempotency to the submitting seat', async () => {
    const { store, events } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const accountA = randomUUID();
    const accountB = randomUUID();
    const sharedActionId = randomUUID();
    await room.seat(accountA, 'A');
    await room.seat(accountB, 'B');
    await room.persistGameState({});
    expect(
      await room.submitAction(accountA, sharedActionId, 'A action', 'A'),
    ).toBe(true);
    expect(
      await room.submitAction(accountB, sharedActionId, 'B action', 'B'),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      events
        .filter((event) => event.type === 'RoundActionAccepted')
        .map((event) => {
          const { accountId, actionId } = (
            event.payload as {
              submission: { accountId: string; actionId: string };
            }
          ).submission;
          return { accountId, actionId };
        }),
    ).toEqual([
      { accountId: accountA, actionId: sharedActionId },
      { accountId: accountB, actionId: sharedActionId },
    ]);
  });
  it('includes an allowed action whose gate was pending when Resolve now began', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    const guest = randomUUID();
    await room.seat(host, 'Host');
    await room.seat(guest, 'Guest');
    await room.persistGameState({});
    const first = randomUUID();
    const second = randomUUID();
    await room.submitAction(host, first, 'Host action', 'Host');
    const receiptSeq = room.registerActionReceipt(second);
    const closing = room.resolveNow(host);
    const gatedSubmission = room.submitAction(
      guest,
      second,
      'Guest action',
      'Guest',
      receiptSeq,
    );
    await Promise.all([closing, gatedSubmission]);
    const resolved = events.find((event) => event.type === 'RoundResolved');
    expect(
      (resolved?.payload as { actions: { actionId: string }[] }).actions.map(
        (action) => action.actionId,
      ),
    ).toEqual([first, second]);
  });
  it('rejects Resolve now while the table is paused', async () => {
    const { store } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    await room.setPaused(host, true, true);
    await expect(room.resolveNow(host)).rejects.toMatchObject({
      name: 'RoomPausedError',
    });
  });
  it.each([false, true])(
    'resumes a recovered resolve-now close after restart (paused=%s)',
    async (paused) => {
      const { store, events } = fixture();
      events.push({
        sessionId: id,
        seq: 1,
        turnId: randomUUID(),
        type: 'Seed',
        payload: {},
        ts: new Date(),
      });
      const accountId = randomUUID();
      const seatId = randomUUID();
      const actionId = randomUUID();
      const latest: LatestState = {
        snapshot: {
          sessionId: id,
          seq: 1,
          createdAt: new Date(),
          state: {
            sessionId: id,
            phase: 'lobby',
            seats: [
              {
                seatId,
                accountId,
                displayName: 'Host',
                presence: 'online',
              },
            ],
            roundsEnabled: true,
            paused,
            gameState: {},
            round: {
              roundId: randomUUID(),
              status: 'closing',
              closeReason: 'resolve-now',
              eligibleSeatIds: [seatId],
              deadlineAt: null,
              submissions: [
                {
                  seatId,
                  accountId,
                  actionId,
                  originalActionId: actionId,
                  actionIds: [actionId],
                  text: 'Finish this action',
                  playerName: 'Host',
                  receiptSeq: 1,
                },
              ],
              queuedSubmissions: [],
            },
          },
        },
        events: [],
      };
      const room = new Room(store, lease, latest, {
        async run() {
          return {
            narration: 'Recovered and resolved.',
            events: [],
            state: {},
            turnSeed: 'seed',
            usage: { in: 0, out: 0 },
          };
        },
      });
      if (paused) await room.setPaused(accountId, false, true);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const check = () => {
          if (events.some((event) => event.type === 'RoundCompleted')) {
            resolve();
          } else if (Date.now() >= deadline) {
            reject(new Error('Recovered round did not complete'));
          } else {
            setTimeout(check, 5);
          }
        };
        check();
      });
      expect(
        events.filter((event) => event.type === 'RoundResolved'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'RoundCompleted'),
      ).toHaveLength(1);
      await room.drain(100);
    },
  );
  it('keeps the previous version when an edit gate blocks during close and rejects later edits', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    const original = randomUUID();
    await room.submitAction(host, original, 'Original text', 'Host');
    const editId = randomUUID();
    const receiptSeq = room.registerActionReceipt(editId);
    const closing = room.resolveNow(host);
    // BLOCK is represented by completing the gate with no allow decision.
    room.completeActionReceipt(receiptSeq);
    await closing;
    const editResult = await room.editAction(
      host,
      randomUUID(),
      original,
      'blocked replacement',
    );
    expect(editResult).toBe('round_closed');
    const resolved = events.find((event) => event.type === 'RoundResolved');
    expect(
      (resolved?.payload as { actions: { text: string }[] }).actions[0]?.text,
    ).toBe('Original text');
  });
  it('accepts an allowed edit that reaches the close decision before the gate grace expires', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    const original = randomUUID();
    await room.submitAction(host, original, 'Original text', 'Host', 42);
    const editId = randomUUID();
    const receiptSeq = room.registerActionReceipt(editId);
    const closing = room.resolveNow(host);
    const edit = room.editAction(
      host,
      editId,
      original,
      'Allowed replacement',
      receiptSeq,
    );
    await Promise.all([closing, edit]);
    const resolved = events.find((event) => event.type === 'RoundResolved');
    expect(
      (resolved?.payload as { actions: { text: string; receiptSeq: number }[] })
        .actions[0],
    ).toMatchObject({ text: 'Allowed replacement', receiptSeq: 42 });
  });
  it('serializes all-in and host resolve races to one resolution', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    const guest = randomUUID();
    await room.seat(host, 'Host');
    await room.seat(guest, 'Guest');
    await room.persistGameState({});
    await room.submitAction(host, randomUUID(), 'Host action', 'Host');
    await Promise.all([
      room.submitAction(guest, randomUUID(), 'Guest action', 'Guest'),
      room.resolveNow(host),
    ]);
    expect(
      events.filter((event) => event.type === 'RoundResolved'),
    ).toHaveLength(1);
  });
  it('applies a host timer change only to the next round and supports off', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    const currentDeadline = room.state.round?.deadlineAt;
    await room.configureRoundTimer(host, null);
    expect(room.state.round?.deadlineAt).toBe(currentDeadline);
    expect(room.state.roundDurationMs).toBeNull();
    await room.submitAction(host, randomUUID(), 'I act.', 'Host');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(room.state.round?.status).toBe('open');
    expect(room.state.round?.deadlineAt).toBeNull();
    expect(
      events.filter((event) => event.type === 'RoundResolved'),
    ).toHaveLength(1);
  });
  it('closes a timer/resolve-now race exactly once', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.configureRoundTimer(host, 30_000);
    await room.persistGameState({});
    const roundId = room.state.round!.roundId;
    await new Promise((resolve) => setTimeout(resolve, 3));
    await room.resolveNow(host);
    const closures = events.filter(
      (event) =>
        (event.type === 'RoundResolved' || event.type === 'RoundClosedEmpty') &&
        (event.payload as { roundId?: string }).roundId === roundId,
    );
    expect(closures).toHaveLength(1);
    await room.drain(20);
  });
  it('keeps a blocked gated submission out of the round batch', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const requests: string[] = [];
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run(request) {
        requests.push(request.text);
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    const blockedSeat = randomUUID();
    await room.seat(host, 'Host');
    await room.seat(blockedSeat, 'Blocked');
    await room.persistGameState({});
    await room.submitAction(host, randomUUID(), 'Allowed action', 'Host');
    const blockedActionId = randomUUID();
    const receiptSeq = room.registerActionReceipt(blockedActionId);
    const closing = room.resolveNow(host);
    room.completeActionReceipt(receiptSeq);
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toEqual(['Allowed action']);
    expect(
      JSON.stringify(
        events.find((event) => event.type === 'RoundResolved')?.payload,
      ),
    ).not.toContain('Blocked action');
  });
  it('withdraws before close or leaves the frozen batch unchanged, never both', async () => {
    const { store, events } = fixture();
    store.isTableHost = async () => true;
    const room = new Room(store, lease, await store.loadLatest(id), {
      async run() {
        return {
          narration: 'Resolved.',
          events: [],
          state: {},
          turnSeed: 'seed',
          usage: { in: 0, out: 0 },
        };
      },
    });
    const host = randomUUID();
    await room.seat(host, 'Host');
    await room.persistGameState({});
    const actionId = randomUUID();
    await room.submitAction(host, actionId, 'Withdraw me', 'Host');
    const close = room.resolveNow(host);
    const withdraw = room.withdrawRoundAction(host, randomUUID(), actionId);
    await Promise.all([close, withdraw]);
    const resolved = events.filter((event) => event.type === 'RoundResolved');
    const empty = events.filter((event) => event.type === 'RoundClosedEmpty');
    expect(resolved.length + empty.length).toBe(1);
    if (resolved.length)
      expect(
        (resolved[0]!.payload as { actions: { text: string }[] }).actions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Withdraw me' }),
        ]),
      );
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
