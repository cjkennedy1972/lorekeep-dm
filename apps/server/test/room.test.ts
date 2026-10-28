import { randomUUID } from 'node:crypto';
import { StateSyncSchema } from '@game/schema';
import { describe, expect, it, vi } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { rleEncode, type Battlemap } from '@game/schema';
import { advanceTurn } from '../src/room/combatEngine.js';
import {
  Room,
  LateJoinRequestConflictError,
  LateJoinUnavailableError,
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
  let sessionConvertedToParty = false;
  let enforceExpectedHead = false;
  let snapshot: LatestState['snapshot'] = null;
  let characterSnapshot: Record<string, unknown> | undefined;
  const store: RoomStore = {
    async convertSessionToParty() {
      sessionConvertedToParty = true;
    },
    async isAccountActive(accountId) {
      return !inactiveAccounts.has(accountId);
    },
    async validateLateJoinCharacter() {
      return { name: 'Public Hero', classId: 'fighter', level: 2 };
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
    async writeTurn(
      _sessionId,
      inputs,
      state,
      _lease,
      _registryEvents,
      expectedHeadSeq,
      _registryTurnId,
      _rewoundTurnIds,
      transition,
      sessionModeTransition,
    ) {
      if (sessionModeTransition === 'solo-to-party')
        sessionConvertedToParty = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (
        enforceExpectedHead &&
        expectedHeadSeq !== undefined &&
        expectedHeadSeq !== events.length
      )
        throw new Error('Stale room write');
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
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
      return {
        events: stored,
        ...(transition?.kind === 'bind' && characterSnapshot
          ? {
              binding: {
                seatId: transition.seatId,
                accountId: transition.accountId,
                characterSnapshot,
              },
            }
          : {}),
      };
    },
  };
  return {
    store,
    events,
    registryWrites,
    inactiveAccounts,
    sessionConvertedToParty: () => sessionConvertedToParty,
    enforceExpectedHead() {
      enforceExpectedHead = true;
    },
    setCharacterSnapshot(value: Record<string, unknown>) {
      characterSnapshot = value;
    },
    latest: () => store.loadLatest(id),
  };
}

describe('room actor', () => {
  it('fences stale game-state persists without conflicting on sequential multi-event persists', async () => {
    const { store, events, enforceExpectedHead } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const commit = (state: unknown, writes: Record<string, unknown>[]) =>
      (
        room as unknown as {
          commitGameState(
            state: unknown,
            writes: Record<string, unknown>[],
          ): Promise<void>;
        }
      ).commitGameState(state, writes);

    enforceExpectedHead();
    await commit({}, [{ type: 'StateChanged', value: 1 }]);
    await commit({}, [
      { type: 'StateChanged', value: 2 },
      { type: 'StateChanged', value: 3 },
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    const committedCount = events.length;
    events.push({
      sessionId: id,
      seq: events.length + 1,
      turnId: randomUUID(),
      type: 'ConcurrentWrite',
      payload: {},
      ts: new Date(),
    });
    await expect(
      commit({}, [{ type: 'StateChanged', value: 'stale' }]),
    ).rejects.toThrow('Stale room write');
    expect(events).toHaveLength(committedCount + 1);
    expect(events.at(-1)?.type).toBe('ConcurrentWrite');
  });
  it('does not let an expired late-join timer revoke a seat after another room admitted it', async () => {
    const { store, events, enforceExpectedHead } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const host = randomUUID();
    const requester = randomUUID();
    await room.seat(host, 'Host');
    vi.useFakeTimers();
    try {
      const requestPromise = room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      await vi.advanceTimersByTimeAsync(1);
      const requestId = await requestPromise;
      enforceExpectedHead();

      // A second lease owner admitted the request while this actor retained stale state.
      events.push(
        {
          sessionId: id,
          seq: events.length + 1,
          turnId: randomUUID(),
          type: 'SeatJoined',
          payload: {
            seatId: randomUUID(),
            accountId: requester,
            displayName: 'Late joiner',
            presence: 'returning',
          },
          ts: new Date(),
        },
        {
          sessionId: id,
          seq: events.length + 2,
          turnId: randomUUID(),
          type: 'LateJoinAdmitted',
          payload: { requestId },
          ts: new Date(),
        },
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinExpired',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a legacy late-join request without expiresAt during recovery', async () => {
    const { store, events } = fixture();
    const requestId = randomUUID();
    const accountId = randomUUID();
    const pendingSeatId = randomUUID();
    events.push({
      sessionId: id,
      seq: 1,
      turnId: randomUUID(),
      type: 'SeatJoined',
      payload: {
        seatId: pendingSeatId,
        accountId,
        displayName: 'Legacy player',
        presence: 'offline',
      },
      ts: new Date(),
    });
    events.push({
      sessionId: id,
      seq: 2,
      turnId: randomUUID(),
      type: 'LateJoinRequested',
      payload: { requestId, accountId, displayName: 'Legacy player' },
      ts: new Date(),
    });

    const recovered = new Room(
      store,
      lease,
      await store.loadLatest(id),
      undefined,
      undefined,
      [{ seatId: pendingSeatId, accountId, characterSnapshot: {} }],
      true,
    );
    const hostAccountId = randomUUID();
    await recovered.seat(hostAccountId, 'Host');
    await recovered.drain();

    expect(recovered.state.lateJoinRequests).toEqual([]);
    expect(events.map((event) => event.type)).toContain('LateJoinExpired');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SeatRevoked',
        payload: expect.objectContaining({
          seatId: pendingSeatId,
          accountId,
          cause: 'late-join-expired',
        }),
      }),
    );
    expect(events.map((event) => event.type)).toContain(
      'SeatCharacterReleased',
    );
    expect(
      recovered.clientState(hostAccountId).lateJoinRequests ?? [],
    ).not.toContainEqual(expect.objectContaining({ requestId }));
  });

  it('reports a neutral unavailable error when the table ends before a late-join request', async () => {
    const { store } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    room.state.ended = true;

    await expect(
      room.requestLateJoin(randomUUID(), randomUUID(), 1, randomUUID()),
    ).rejects.toBeInstanceOf(LateJoinUnavailableError);
  });

  it('does not count revoked seats toward the six-seat cap', async () => {
    const { store } = fixture();
    const room = new Room(store, lease, await store.loadLatest(id));
    const accounts = Array.from({ length: 6 }, () => randomUUID());
    for (const [index, accountId] of accounts.entries())
      await room.seat(accountId, `Player ${index}`);

    await room.leave(accounts[0]!);
    await expect(
      room.seat(randomUUID(), 'Replacement'),
    ).resolves.toBeUndefined();
    expect(
      room.state.seats.filter((seat) => seat.presence !== 'revoked'),
    ).toHaveLength(6);
  });

  it('resyncs a public round snapshot without other seats’ private text', async () => {
    const { store } = fixture();
    const accountId = randomUUID();
    const seatId = randomUUID();
    const otherAccountId = randomUUID();
    const otherSeatId = randomUUID();
    const actionId = randomUUID();
    const otherActionId = randomUUID();
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
            {
              seatId: otherSeatId,
              accountId: otherAccountId,
              displayName: 'Other',
              presence: 'offline',
            },
          ],
          gameState: {},
          round: {
            roundId,
            status: 'open',
            eligibleSeatIds: [seatId, otherSeatId],
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
              {
                seatId: otherSeatId,
                accountId: otherAccountId,
                actionId: otherActionId,
                originalActionId: otherActionId,
                actionIds: [otherActionId],
                text: 'other private action',
                playerName: 'Other',
                receiptSeq: 3,
              },
            ],
            queuedSubmissions: [],
          },
        },
      },
      events: [],
    });
    const sent: unknown[] = [];
    const otherSent: unknown[] = [];
    await room.subscribe(accountId, { send: (message) => sent.push(message) });
    await room.subscribe(otherAccountId, {
      send: (message) => otherSent.push(message),
    });
    const sync = sent.find(
      (message) => (message as { type?: string }).type === 'StateSync',
    ) as {
      payload: { state: unknown; round?: Record<string, unknown> };
    };
    expect(StateSyncSchema.parse(sync).payload.round).toBeDefined();
    expect(sync.payload.round).toMatchObject({
      roundId,
      status: 'open',
      eligibleSeatIds: [seatId, otherSeatId],
      submissions: [
        { seatId, actionId, actionIds: [actionId], playerName: 'Player' },
        {
          seatId: otherSeatId,
          actionId: otherActionId,
          actionIds: [otherActionId],
          playerName: 'Other',
        },
      ],
      queuedSubmissions: [],
    });
    expect(sync.payload.round).not.toHaveProperty('submissions.0.text');
    expect(JSON.stringify(sync)).not.toContain('private action text');
    expect(JSON.stringify(sync)).not.toContain('other private action');
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'SeatPrivateRoundSync',
        payload: {
          roundId,
          submission: { actionId, text: 'private action text', queued: false },
        },
      }),
    );
    const otherPrivate = otherSent.find(
      (message) =>
        (message as { type?: string }).type === 'SeatPrivateRoundSync',
    );
    expect(otherPrivate).toMatchObject({
      payload: {
        roundId,
        submission: {
          actionId: otherActionId,
          text: 'other private action',
          queued: false,
        },
      },
    });
    expect(JSON.stringify(otherPrivate)).not.toContain('private action text');
    const resyncedSeatB: unknown[] = [];
    await room.subscribe(
      otherAccountId,
      { send: (message) => resyncedSeatB.push(message) },
      -1,
    );
    expect(resyncedSeatB).toContainEqual(
      expect.objectContaining({ type: 'StateSync' }),
    );
    expect(JSON.stringify(resyncedSeatB)).not.toContain('private action text');
    expect(JSON.stringify(resyncedSeatB)).toContain('other private action');
  });

  it('does not send private round submissions to revoked or left seats', async () => {
    const { store } = fixture();
    const accountId = randomUUID();
    const seatId = randomUUID();
    const actionId = randomUUID();
    const revokedMessages: unknown[] = [];
    const roundId = randomUUID();
    const room = new Room(
      store,
      lease,
      {
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
              deadlineAt: null,
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
      },
      undefined,
      undefined,
      [
        {
          seatId,
          accountId,
          characterSnapshot: {
            name: 'Secret sheet name',
            privateNotes: 'never wire this',
          },
        },
      ],
    );
    await room.subscribe(accountId, {
      send: (message) => revokedMessages.push(message),
    });
    const sync = revokedMessages.find(
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
    expect(JSON.stringify(sync)).not.toContain('Secret sheet name');
    expect(JSON.stringify(sync)).not.toContain('never wire this');

    revokedMessages.length = 0;
    room.state.seats[0]!.presence = 'revoked';
    (
      room as unknown as { sendSeatPrivateRoundSync: (id: string) => void }
    ).sendSeatPrivateRoundSync(accountId);
    expect(
      revokedMessages.some(
        (message) =>
          (message as { type?: string }).type === 'SeatPrivateRoundSync',
      ),
    ).toBe(false);

    const left = randomUUID();
    await room.seat(left, 'Left');
    const leftMessages: unknown[] = [];
    await room.subscribe(left, {
      send: (message) => leftMessages.push(message),
    });
    await room.leave(left);
    leftMessages.length = 0;
    (
      room as unknown as { sendSeatPrivateRoundSync: (id: string) => void }
    ).sendSeatPrivateRoundSync(left);
    expect(
      leftMessages.some(
        (message) =>
          (message as { type?: string }).type === 'SeatPrivateRoundSync',
      ),
    ).toBe(false);
    await room.drain();
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
    it('does not persist rejected selections and caps pending requests without creating a fourth record', async () => {
      const { store, events } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      store.validateLateJoinCharacter = async () => {
        throw new Error('invalid selection');
      };
      await expect(
        room.requestLateJoin(randomUUID(), randomUUID(), 1, randomUUID()),
      ).rejects.toThrow('invalid selection');
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinRequested',
      );
      store.validateLateJoinCharacter = async () => ({
        name: 'Hero',
        classId: 'fighter',
        level: 1,
      });
      for (let index = 0; index < 3; index++)
        await room.requestLateJoin(randomUUID(), randomUUID(), 1, randomUUID());
      await expect(
        room.requestLateJoin(randomUUID(), randomUUID(), 1, randomUUID()),
      ).rejects.toThrow('request_limited');
      expect(
        events.filter((event) => event.type === 'LateJoinRequested'),
      ).toHaveLength(3);
    });

    it('validates the selected character before persisting and exposes only its public card to the host', async () => {
      const { store, events } = fixture();
      const host = randomUUID();
      const requester = randomUUID();
      const characterId = randomUUID();
      const actionId = randomUUID();
      const validate = vi.fn(async () => ({
        name: 'Public Hero',
        classId: 'fighter',
        level: 2,
      }));
      store.validateLateJoinCharacter = validate;
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');

      const requestId = await room.requestLateJoin(
        requester,
        characterId,
        3,
        actionId,
        'Private account name',
        true,
      );

      expect(validate).toHaveBeenCalledWith(requester, characterId, 3);
      expect(room.clientState(host).lateJoinRequests).toEqual([
        {
          requestId,
          displayName: 'Public Hero',
          classId: 'fighter',
          level: 2,
          expiresAt: expect.any(Number),
        },
      ]);
      const hostView = room.clientState(host).lateJoinRequests?.[0];
      expect(hostView).not.toHaveProperty('accountId');
      expect(hostView).not.toHaveProperty('characterId');
      expect(hostView).not.toHaveProperty('revision');
      expect(hostView).not.toHaveProperty('expectedRevision');
      expect(room.clientState(randomUUID())).not.toHaveProperty(
        'lateJoinRequests',
      );
      expect(room.clientState(host)).not.toHaveProperty(
        'lateJoinRequestCharacterIds',
      );
      expect(
        events.find((event) => event.type === 'LateJoinRequested')?.payload,
      ).toMatchObject({
        accountId: requester,
        characterId,
        matureOptOut: true,
      });
      expect(
        await room.requestLateJoin(
          requester,
          characterId,
          3,
          actionId,
          'Private account name',
          true,
        ),
      ).toBe(requestId);
      expect(
        events.filter((event) => event.type === 'LateJoinRequested'),
      ).toHaveLength(1);
    });

    it('rejects an action ID replay when its request result is unavailable for that account', async () => {
      const { store } = fixture();
      const room = new Room(store, lease, await store.loadLatest(id));
      const actionId = randomUUID();
      await room.requestLateJoin(randomUUID(), randomUUID(), 1, actionId);
      await expect(
        room.requestLateJoin(randomUUID(), randomUUID(), 1, actionId),
      ).rejects.toBeInstanceOf(LateJoinRequestConflictError);
    });

    it('rejects a different character selection while the requester has a pending request', async () => {
      const { store } = fixture();
      const room = new Room(store, lease, await store.loadLatest(id));
      const requester = randomUUID();
      await room.requestLateJoin(requester, randomUUID(), 1, randomUUID());
      await expect(
        room.requestLateJoin(requester, randomUUID(), 1, randomUUID()),
      ).rejects.toBeInstanceOf(LateJoinRequestConflictError);
    });

    it('rejects a changed character on request replay after cancellation while preserving the equivalent replay result', async () => {
      const { store } = fixture();
      const room = new Room(store, lease, await store.loadLatest(id));
      const requester = randomUUID();
      const characterId = randomUUID();
      const actionId = randomUUID();
      const requestId = await room.requestLateJoin(
        requester,
        characterId,
        1,
        actionId,
      );
      await room.cancelLateJoin(requester, randomUUID(), requestId);
      await expect(
        room.requestLateJoin(requester, randomUUID(), 1, actionId),
      ).rejects.toBeInstanceOf(LateJoinRequestConflictError);
      await expect(
        room.requestLateJoin(requester, characterId, 1, actionId),
      ).resolves.toBe(requestId);
    });

    it('replays cancel and deny action IDs only to their original actor', async () => {
      const { store } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      const requester = randomUUID();
      const cancelled = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      const cancelAction = randomUUID();
      await room.cancelLateJoin(requester, cancelAction, cancelled);
      const afterCancelRestart = new Room(
        store,
        lease,
        await store.loadLatest(id),
      );
      await expect(
        afterCancelRestart.cancelLateJoin(requester, cancelAction, cancelled),
      ).resolves.toBeUndefined();
      const foreignAccount = randomUUID();
      const foreignError = await afterCancelRestart
        .cancelLateJoin(foreignAccount, cancelAction, cancelled)
        .catch((error: unknown) => error);
      const unknownRequestError = await afterCancelRestart
        .cancelLateJoin(foreignAccount, cancelAction, randomUUID())
        .catch((error: unknown) => error);
      expect(foreignError).toBeInstanceOf(Error);
      expect((foreignError as Error).message).toBe(
        (unknownRequestError as Error).message,
      );
      await expect(
        afterCancelRestart.cancelLateJoin(
          foreignAccount,
          cancelAction,
          cancelled,
        ),
      ).rejects.toThrow();

      const deniedAccountId = randomUUID();
      const denied = await room.requestLateJoin(
        deniedAccountId,
        randomUUID(),
        1,
        randomUUID(),
      );
      const denyAction = randomUUID();
      const originalDenyResult = await room.denyLateJoin(
        host,
        denyAction,
        denied,
      );
      const afterDenyRestart = new Room(
        store,
        lease,
        await store.loadLatest(id),
      );
      await expect(
        afterDenyRestart.denyLateJoin(host, denyAction, denied),
      ).resolves.toBe(originalDenyResult);
      const otherDeniedAccountId = randomUUID();
      const otherDenied = await afterDenyRestart.requestLateJoin(
        otherDeniedAccountId,
        randomUUID(),
        1,
        randomUUID(),
      );
      await expect(
        afterDenyRestart.denyLateJoin(host, denyAction, otherDenied),
      ).rejects.toThrow();
      expect(afterDenyRestart.state.lateJoinRequests).toContainEqual(
        expect.objectContaining({ requestId: otherDenied }),
      );
      await expect(
        afterDenyRestart.denyLateJoin(randomUUID(), denyAction, denied),
      ).rejects.toThrow();
      const retryActionId = randomUUID();
      const retryCharacterId = randomUUID();
      const retryId = await afterDenyRestart.requestLateJoin(
        deniedAccountId,
        retryCharacterId,
        1,
        retryActionId,
      );
      expect(retryId).not.toBe(denied);
      await expect(
        afterDenyRestart.requestLateJoin(
          deniedAccountId,
          retryCharacterId,
          1,
          retryActionId,
        ),
      ).resolves.toBe(retryId);
    });

    it('bounds persisted late-join request replay results', async () => {
      const { store } = fixture();
      const room = new Room(store, lease, await store.loadLatest(id));
      const cancelActionIds: string[] = [];
      for (let index = 0; index < 260; index++) {
        const requester = randomUUID();
        const requestId = await room.requestLateJoin(
          requester,
          randomUUID(),
          1,
          randomUUID(),
        );
        const cancelActionId = randomUUID();
        cancelActionIds.push(cancelActionId);
        await room.cancelLateJoin(requester, cancelActionId, requestId);
      }
      expect(Object.keys(room.state.lateJoinRequestResults ?? {})).toHaveLength(
        256,
      );
      expect(Object.keys(room.state.lateJoinActionOwners ?? {})).toHaveLength(
        256,
      );
      expect(room.state.lateJoinActionOwners).not.toHaveProperty(
        cancelActionIds[0]!,
      );
      expect(room.state.lateJoinActionOwners).toHaveProperty(
        cancelActionIds.at(-1)!,
      );
    });

    it('requires host authorization before replaying committed late-join actions', async () => {
      const { store } = fixture();
      const host = randomUUID();
      const player = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.seat(player, 'Player');

      const approvedRequestId = await room.requestLateJoin(
        randomUUID(),
        randomUUID(),
        1,
        randomUUID(),
      );
      const approveActionId = randomUUID();
      await room.approveLateJoin(host, approveActionId, approvedRequestId);
      const committedApproveError = await room
        .approveLateJoin(player, approveActionId, randomUUID())
        .catch((error: unknown) => error);
      const freshApproveError = await room
        .approveLateJoin(player, randomUUID(), randomUUID())
        .catch((error: unknown) => error);
      expect((committedApproveError as Error).message).toBe(
        (freshApproveError as Error).message,
      );

      const deniedRequestId = await room.requestLateJoin(
        randomUUID(),
        randomUUID(),
        1,
        randomUUID(),
      );
      const denyActionId = randomUUID();
      await room.denyLateJoin(host, denyActionId, deniedRequestId);
      const committedDenyError = await room
        .denyLateJoin(player, denyActionId, randomUUID())
        .catch((error: unknown) => error);
      const freshDenyError = await room
        .denyLateJoin(player, randomUUID(), randomUUID())
        .catch((error: unknown) => error);
      expect((committedDenyError as Error).message).toBe(
        (freshDenyError as Error).message,
      );
    });

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
      expect(
        [...events].reverse().find((event) => event.type === 'SeatRevoked'),
      ).toMatchObject({
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
      const requestId = await room.requestLateJoin(
        randomUUID(),
        randomUUID(),
        1,
        randomUUID(),
      );

      await expect(
        room.approveLateJoin(host, randomUUID(), requestId),
      ).resolves.toBeUndefined();
    });

    it('admits a combat join after its joining round and starts it next round', async () => {
      const { store, events, setCharacterSnapshot } = fixture();
      const host = randomUUID();
      const hostEntityId = 'host-entity';
      const character = quickBuild(loadCatalog(), undefined, 0x38, 1).character;
      setCharacterSnapshot(character);
      store.validateLateJoinCharacter = async () => ({
        name: character.name,
        classId: character.classId,
        level: character.level,
      });
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const map: Battlemap = {
        mapId: 'combat-map',
        w: 3,
        h: 2,
        palette: [
          {
            terrainId: 'floor',
            moveCost: 1,
            blocksMove: false,
            blocksSight: false,
            cover: 'none',
            elevation: 0,
          },
        ],
        cells: rleEncode(Array(6).fill(0)),
        edges: [],
        features: [],
        markers: [
          { markerId: 'party-entry', cell: { x: 0, y: 0 }, label: 'Entry' },
        ],
        zones: [
          {
            zoneId: 'player-entry',
            kind: 'spawn',
            cells: [
              { x: 1, y: 0 },
              { x: 2, y: 0 },
            ],
          },
        ],
        diagonalRule: '5ft',
      };
      const entity = {
        id: hostEntityId,
        name: 'Host hero',
        kind: 'character',
        team: 'party',
        pos: { x: 0, y: 0 },
        size: 1,
        hp: 10,
        maxHp: 10,
        speed: 30,
      };
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.persistGameState({
        sceneId: 'scene-combat',
        combatActors: { [host]: hostEntityId },
        gameEngine: { map, entities: [entity] },
        combatRoom: {
          map,
          entities: [entity],
          combat: {
            round: 1,
            activeEntityId: hostEntityId,
            initiative: [{ entityId: hostEntityId, total: 20 }],
            resources: {
              [hostEntityId]: {
                action: true,
                bonusAction: true,
                reaction: true,
                movementRemaining: 30,
              },
            },
          },
          seed: 1,
        },
      });
      const requester = randomUUID();
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      await room.approveLateJoin(host, randomUUID(), requestId);
      expect(
        room.state.lateJoinRequests?.some(
          (item) => item.requestId === requestId,
        ),
      ).toBe(true);

      await room.submitCombatCommand(host, randomUUID(), {
        command: 'end-turn',
      });
      const roomInternals = room as unknown as {
        enqueue<T>(work: () => Promise<T>): Promise<T>;
        admitApprovedLateJoins(): Promise<void>;
      };
      // Serialize the simulated boundary with the Room mailbox so the test
      // cannot race the production round-boundary callback.
      await roomInternals.enqueue(() => roomInternals.admitApprovedLateJoins());
      const pendingSeat = room.state.seats.find(
        (seat) => seat.accountId === requester,
      )!;
      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
      await room.acknowledgeLateJoinSnapshot(
        requester,
        pendingSeat.seatId,
        room.seq,
      );
      await roomInternals.enqueue(() => roomInternals.admitApprovedLateJoins());
      // Wait for the admission
      await vi.waitFor(
        () =>
          expect(events.some((event) => event.type === 'LateJoinSpawned')).toBe(
            true,
          ),
        { timeout: 5000 },
      );
      const admission = events.find(
        (event) => event.type === 'LateJoinSpawned',
      );
      expect(admission?.payload.initiativeEffectiveRound).toBe(3);
      const combat = (
        room.state.gameState as {
          combatRoom: import('../src/room/combatTypes.js').RoomCombatState;
        }
      ).combatRoom;
      const transition = advanceTurn(combat);
      expect(transition.events).toContainEqual({
        type: 'TurnStarted',
        entityId: admission?.payload.entityId,
        round: 3,
      });
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(true);
    });

    it('contains a failed fire-and-forget combat-boundary admission and leaves it pending', async () => {
      const { store, events, setCharacterSnapshot } = fixture();
      const host = randomUUID();
      const requester = randomUUID();
      const character = quickBuild(loadCatalog(), undefined, 0x39, 1).character;
      setCharacterSnapshot(character);
      store.validateLateJoinCharacter = async () => ({
        name: character.name,
        classId: 'fighter',
        level: 1,
      });
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const writeTurn = store.writeTurn.bind(store);
      let failNextBindingWrite = true;
      store.writeTurn = async (...args) => {
        if (failNextBindingWrite && args[8]?.kind === 'bind') {
          failNextBindingWrite = false;
          throw new Error('simulated admission storage failure');
        }
        return writeTurn(...args);
      };
      const map: Battlemap = {
        mapId: 'admission-failure-map',
        w: 3,
        h: 2,
        palette: [
          {
            terrainId: 'floor',
            moveCost: 1,
            blocksMove: false,
            blocksSight: false,
            cover: 'none',
            elevation: 0,
          },
        ],
        cells: rleEncode(Array(6).fill(0)),
        edges: [],
        features: [],
        markers: [],
        zones: [
          { zoneId: 'player-entry', kind: 'spawn', cells: [{ x: 1, y: 0 }] },
        ],
        diagonalRule: '5ft',
      };
      const hostEntity = {
        id: 'host-entity',
        name: 'Host hero',
        kind: 'character',
        team: 'party',
        pos: { x: 0, y: 0 },
        size: 1,
        hp: 10,
        maxHp: 10,
        speed: 30,
      };
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.persistGameState({
        sceneId: 'scene-combat',
        combatActors: { [host]: hostEntity.id },
        gameEngine: { map, entities: [hostEntity] },
        combatRoom: {
          map,
          entities: [hostEntity],
          combat: {
            round: 1,
            activeEntityId: hostEntity.id,
            initiative: [{ entityId: hostEntity.id, total: 20 }],
            resources: {
              [hostEntity.id]: {
                action: true,
                bonusAction: true,
                reaction: true,
                movementRemaining: 30,
              },
            },
          },
          seed: 1,
        },
      });
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      await room.approveLateJoin(host, randomUUID(), requestId);
      const internals = room as unknown as {
        enqueue<T>(work: () => Promise<T>): Promise<T>;
        admitApprovedLateJoins(): Promise<void>;
        announceCombat(
          state: never,
          events: Record<string, unknown>[],
          accountId?: string,
        ): void;
      };
      // Establish the authorized seat; binding waits for snapshot acknowledgement.
      await internals.enqueue(() => internals.admitApprovedLateJoins());
      const pendingSeat = room.state.seats.find(
        (seat) => seat.accountId === requester,
      )!;
      await room.acknowledgeLateJoinSnapshot(
        requester,
        pendingSeat.seatId,
        room.seq,
      );
      const messages: Record<string, unknown>[] = [];
      await room.subscribe(host, {
        send(message: Record<string, unknown>) {
          messages.push(message);
        },
      });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.on('unhandledRejection', onUnhandled);
      try {
        const combat = (
          room.state.gameState as {
            combatRoom: import('../src/room/combatTypes.js').RoomCombatState;
          }
        ).combatRoom;
        internals.announceCombat(
          { ...combat, combat: { ...combat.combat, round: 2 } } as never,
          [{ type: 'TurnStarted', round: 2 }],
          host,
        );
        await vi.waitFor(() =>
          expect(logged).toHaveBeenCalledWith(
            `Late-join admission failed for ${id}`,
            expect.any(Error),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(unhandled).toEqual([]);
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: 'Error',
            payload: expect.objectContaining({
              code: 'LATE_JOIN_ADMISSION_FAILED',
            }),
          }),
        );
        expect(
          room.state.lateJoinRequests?.some(
            (request) => request.requestId === requestId && request.approved,
          ),
        ).toBe(true);
        expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
        expect(events.map((event) => event.type)).not.toContain(
          'LateJoinAdmitted',
        );
        await expect(
          room.submitAction(requester, randomUUID(), 'Take a turn'),
        ).rejects.toThrow();
        await room.seat(randomUUID(), 'Another player');
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        logged.mockRestore();
      }
    });

    it('expires an approved late join that reaches admission after its deadline', async () => {
      const { store, events } = fixture();
      const host = randomUUID();
      const requester = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      let releaseAccountCheck!: (active: boolean) => void;
      let reachedAccountCheck!: () => void;
      const accountCheckStarted = new Promise<void>((resolve) => {
        reachedAccountCheck = resolve;
      });
      store.isAccountActive = () => {
        reachedAccountCheck();
        return new Promise<boolean>((resolve) => {
          releaseAccountCheck = resolve;
        });
      };
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      await room.approveLateJoin(host, randomUUID(), requestId);
      const request = room.state.lateJoinRequests?.find(
        (item) => item.requestId === requestId,
      );
      expect(request?.expiresAt).toBeTypeOf('number');

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const admission = (
          room as unknown as { admitApprovedLateJoins(): Promise<void> }
        ).admitApprovedLateJoins();
        await accountCheckStarted;
        vi.setSystemTime((request?.expiresAt ?? Date.now()) + 1);
        releaseAccountCheck(true);
        await admission;
      } finally {
        vi.useRealTimers();
      }

      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'LateJoinExpired',
          payload: { requestId, reason: 'expired' },
        }),
      );
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinAdmitted',
      );
    });

    it('does not admit an approved late join after their account becomes inactive', async () => {
      const { store, events, inactiveAccounts } = fixture();
      const host = randomUUID();
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const room = new Room(store, lease, await store.loadLatest(id));
      await room.seat(host, 'Host');
      await room.persistGameState({});
      const requester = randomUUID();
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
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
      const { store, events, setCharacterSnapshot, sessionConvertedToParty } =
        fixture();
      const host = randomUUID();
      const character = quickBuild(loadCatalog(), undefined, 0x35, 1).character;
      setCharacterSnapshot(character);
      store.validateLateJoinCharacter = async () => ({
        name: character.name,
        classId: character.classId,
        level: character.level,
      });
      const map: Battlemap = {
        mapId: 'scene-map',
        w: 3,
        h: 2,
        palette: [
          {
            terrainId: 'floor',
            moveCost: 1,
            blocksMove: false,
            blocksSight: false,
            cover: 'none',
            elevation: 0,
          },
        ],
        cells: rleEncode(Array(6).fill(0)),
        edges: [],
        features: [],
        markers: [
          { markerId: 'party-entry', cell: { x: 0, y: 0 }, label: 'Entry' },
        ],
        zones: [
          {
            zoneId: 'player-entry',
            kind: 'spawn',
            cells: [
              { x: 1, y: 0 },
              { x: 2, y: 0 },
            ],
          },
        ],
        diagonalRule: '5ft',
      };
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
      const room = new Room(
        store,
        lease,
        await store.loadLatest(id),
        runner,
        undefined,
        [],
        false,
      );
      await room.seat(host, 'Host');
      await room.bindSeatCharacter(
        host,
        character.id,
        1,
        async () => true,
        randomUUID(),
      );
      await room.persistGameState({
        sceneId: 'scene-1',
        gameEngine: { map, entities: [] },
      });
      const requester = randomUUID();
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      await room.approveLateJoin(host, randomUUID(), requestId);
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(false);
      await room.submitAction(host, randomUUID(), 'close the scene');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pendingSeat = room.state.seats.find(
        (seat) => seat.accountId === requester,
      )!;
      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinSpawned',
      );
      await expect(
        room.submitAction(requester, randomUUID(), 'take a turn'),
      ).rejects.toThrow();
      await room.acknowledgeLateJoinSnapshot(
        host,
        pendingSeat.seatId,
        room.seq,
      );
      await room.acknowledgeLateJoinSnapshot(requester, randomUUID(), room.seq);
      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
      await room.acknowledgeLateJoinSnapshot(
        requester,
        pendingSeat.seatId,
        room.seq,
      );
      await room.acknowledgeLateJoinSnapshot(
        requester,
        pendingSeat.seatId,
        room.seq,
      );
      await (
        room as unknown as { admitApprovedLateJoins(): Promise<void> }
      ).admitApprovedLateJoins();
      expect(
        room.state.seats.some((seat) => seat.accountId === requester),
      ).toBe(true);
      expect(sessionConvertedToParty()).toBe(true);
      expect(events.map((event) => event.type)).toContain('LateJoinApproved');
      expect(events.map((event) => event.type)).toContain('LateJoinAdmitted');
      expect(events.map((event) => event.type)).toContain('LateJoinSpawned');
      expect(events.map((event) => event.type)).toContain('EntityPlaced');
      expect(
        events.findIndex((event) => event.type === 'SeatCharacterBound'),
      ).toBeLessThan(
        events.findIndex((event) => event.type === 'EntityPlaced'),
      );
      expect(
        events.filter(
          (event) =>
            event.type === 'SeatCharacterBound' &&
            event.payload.seatId === pendingSeat.seatId,
        ),
      ).toHaveLength(1);
      expect(
        room.seatCharacters.has(
          room.state.seats.find((seat) => seat.accountId === requester)!.seatId,
        ),
      ).toBe(true);
      const spawned = events.find((event) => event.type === 'LateJoinSpawned')!;
      const restarted = new Room(store, lease, await store.loadLatest(id));
      expect(
        (
          restarted.state.gameState as {
            gameEngine?: { entities?: { id: string }[] };
          }
        ).gameEngine?.entities?.some(
          (entity) => entity.id === spawned.payload.entityId,
        ),
      ).toBe(true);
    });

    it('keeps an approved join pending without a legal spawn and releases its binding when declined', async () => {
      const { store, events, setCharacterSnapshot } = fixture();
      const host = randomUUID();
      const requester = randomUUID();
      const character = quickBuild(loadCatalog(), undefined, 0x36, 1).character;
      setCharacterSnapshot(character);
      store.validateLateJoinCharacter = async () => ({
        name: character.name,
        classId: character.classId,
        level: character.level,
      });
      store.isTableHost = async (_sessionId, accountId) => accountId === host;
      const runner: SoloTurnRunner = {
        async run(request) {
          return {
            narration: 'The scene closes.',
            events: [
              { type: 'TurnStarted', turnId: 'turn-no-spawn' },
              {
                type: 'SceneClosed',
                sceneId: 'scene-no-spawn',
                summary: 'Done.',
              },
            ],
            state: request.state as Record<string, unknown>,
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
          };
        },
      };
      const room = new Room(
        store,
        lease,
        await store.loadLatest(id),
        runner,
        undefined,
        [],
        true,
      );
      await room.seat(host, 'Host');
      await room.bindSeatCharacter(
        host,
        character.id,
        1,
        async () => true,
        randomUUID(),
      );
      await room.persistGameState({
        sceneId: 'scene-no-spawn',
        gameEngine: {
          map: {
            mapId: 'no-space',
            w: 2,
            h: 1,
            palette: [
              {
                terrainId: 'floor',
                moveCost: 1,
                blocksMove: false,
                blocksSight: false,
                cover: 'none',
                elevation: 0,
              },
            ],
            cells: rleEncode([0, 0]),
            edges: [],
            features: [],
            markers: [
              { markerId: 'party-entry', cell: { x: 0, y: 0 }, label: 'Entry' },
            ],
            zones: [
              {
                zoneId: 'player-entry',
                kind: 'spawn',
                cells: [{ x: 1, y: 0 }],
              },
            ],
            diagonalRule: '5ft',
          },
          entities: [
            {
              id: 'party-already-here',
              team: 'party',
              size: 1,
              pos: { x: 1, y: 0 },
            },
          ],
        },
      });
      const requestId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      await room.approveLateJoin(host, randomUUID(), requestId);
      await room.submitAction(host, randomUUID(), 'close the scene');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pendingSeat = room.state.seats.find(
        (seat) => seat.accountId === requester,
      )!;
      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
      await room.acknowledgeLateJoinSnapshot(
        requester,
        pendingSeat.seatId,
        room.seq,
      );
      await (
        room as unknown as { admitApprovedLateJoins(): Promise<void> }
      ).admitApprovedLateJoins();
      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(true);
      expect(
        room.state.lateJoinRequests?.some(
          (item) => item.requestId === requestId,
        ),
      ).toBe(true);
      expect(events.map((event) => event.type)).not.toContain(
        'LateJoinSpawned',
      );
      await expect(
        room.submitAction(requester, randomUUID(), 'take a turn'),
      ).rejects.toThrow();

      await room.denyLateJoin(host, randomUUID(), requestId);

      expect(room.seatCharacters.has(pendingSeat.seatId)).toBe(false);
      expect(events.map((event) => event.type)).toContain(
        'SeatCharacterReleased',
      );
      expect(events.map((event) => event.type)).toContain('LateJoinDenied');
      for (let index = 0; index < 4; index++)
        await room.seat(randomUUID(), `Other player ${index}`);
      const retryId = await room.requestLateJoin(
        requester,
        randomUUID(),
        1,
        randomUUID(),
      );
      expect(retryId).not.toBe('');
      expect(retryId).not.toBe(requestId);
      expect(
        room.state.seats.filter((seat) => seat.presence !== 'revoked'),
      ).toHaveLength(5);
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
  it('does not promote a resolved-window queue item after its seat is revoked', async () => {
    const { store, events } = fixture();
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
    const revokedAccount = randomUUID();
    await room.seat(host, 'Host');
    await room.seat(revokedAccount, 'Revoked');
    await room.persistGameState({});
    await room.submitAction(host, randomUUID(), 'Host action', 'Host');
    const revokedSeatId = room.state.seats.find(
      (seat) => seat.accountId === revokedAccount,
    )!.seatId;
    await room.submitAction(revokedAccount, randomUUID(), 'Resolve', 'Revoked');
    await started;
    const queuedAction = randomUUID();
    expect(
      await room.submitAction(
        revokedAccount,
        queuedAction,
        'Queued before revocation',
        'Revoked',
      ),
    ).toBe(true);
    // Model revocation after acceptance but before openRound computes eligibility.
    room.state.seats.find((seat) => seat.seatId === revokedSeatId)!.presence =
      'revoked';
    finishTurn();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (room.state.round?.status === 'open') break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(room.state.round?.eligibleSeatIds).not.toContain(revokedSeatId);
    expect(room.state.round?.submissions).toEqual([]);
    expect(room.state.round?.queuedSubmissions).toEqual([]);
    expect(room.hasActionId(queuedAction, undefined, revokedAccount)).toBe(
      true,
    );
    expect(
      events.filter((event) => event.type === 'RoundOpened').at(-1)?.payload,
    ).toMatchObject({ submissions: [] });
    await room.drain(100);
  });
  it('enforces queued-action caps in the resolving window', async () => {
    for (const cap of ['seat', 'room'] as const) {
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
      await room.submitAction(host, randomUUID(), 'Initial', 'Host');
      await started;
      const round = room.state.round!;
      const count = cap === 'seat' ? 3 : 12;
      round.queuedSubmissions = Array.from({ length: count }, (_, index) => ({
        seatId: randomUUID(),
        accountId: cap === 'seat' ? host : randomUUID(),
        actionId: randomUUID(),
        originalActionId: randomUUID(),
        actionIds: [randomUUID()],
        text: 'already queued',
        playerName: 'Queued',
        receiptSeq: index + 1,
      }));
      await expect(
        room.submitAction(host, randomUUID(), 'Over cap', 'Host'),
      ).rejects.toThrow('ACTION_REJECTED');
      finishTurn();
      await room.drain(100);
    }
  });
  it('enforces queued-action caps in the resolved window', async () => {
    for (const cap of ['seat', 'room'] as const) {
      const { store } = fixture();
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
      const round = room.state.round!;
      round.status = 'resolved';
      const count = cap === 'seat' ? 3 : 12;
      round.queuedSubmissions = Array.from({ length: count }, (_, index) => ({
        seatId: randomUUID(),
        accountId: cap === 'seat' ? host : randomUUID(),
        actionId: randomUUID(),
        originalActionId: randomUUID(),
        actionIds: [randomUUID()],
        text: 'already queued',
        playerName: 'Queued',
        receiptSeq: index + 1,
      }));
      await expect(
        room.submitAction(host, randomUUID(), 'Over cap', 'Host'),
      ).rejects.toThrow('ACTION_REJECTED');
      await room.drain(100);
    }
  });
  it('edits a queued action during the resolved window', async () => {
    const { store } = fixture();
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
    room.state.round!.status = 'resolved';
    const actionId = randomUUID();
    await room.submitAction(host, actionId, 'Queued', 'Host');
    expect(await room.editAction(host, randomUUID(), actionId, 'Edited')).toBe(
      'edited',
    );
    expect(room.state.round?.queuedSubmissions).toMatchObject([
      { originalActionId: actionId, text: 'Edited' },
    ]);
    await room.drain(100);
  });
  it('withdraws a queued action during the resolved window', async () => {
    const { store } = fixture();
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
    room.state.round!.status = 'resolved';
    const actionId = randomUUID();
    await room.submitAction(host, actionId, 'Queued', 'Host');
    expect(await room.withdrawRoundAction(host, randomUUID(), actionId)).toBe(
      'withdrawn',
    );
    expect(room.state.round?.queuedSubmissions).toEqual([]);
    await room.drain(100);
  });
  it('accepts an action sent right after narration completes, before the next round opens', async () => {
    const { store } = fixture();
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
    const followUp = randomUUID();
    let followUpResult: Promise<unknown> | undefined;
    await room.join(host, {
      send: (message) => {
        if (
          (message as { type: string }).type === 'NarrationCompleted' &&
          !followUpResult
        )
          followUpResult = room.submitAction(host, followUp, 'Next', 'Host');
      },
    });
    await room.submitAction(host, randomUUID(), 'First', 'Host');
    for (let attempt = 0; attempt < 100 && !followUpResult; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await followUpResult).toBe(true);
    await room.drain(100);
    expect(room.state.round?.submissions).toMatchObject([
      { actionId: followUp, text: 'Next' },
    ]);
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
    expect(events.filter((event) => event.type === 'SeatRevoked')).toHaveLength(
      1,
    );
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
    expect(stale).toMatchObject([
      { type: 'StateSync', seq: currentSeq },
      { type: 'NarrationHistory', payload: { turns: [] } },
    ]);
    expect(current).toMatchObject([
      { type: 'NarrationHistory', payload: { turns: [] } },
    ]);
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
    const messagesA: unknown[] = [];
    await room.subscribe(accountA, {
      send: (message) => messagesA.push(message),
    });
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
    expect(resolved[0]?.payload).toMatchObject({
      closeReason: 'all-submitted',
    });
    expect(
      (
        resolved[0]?.payload as { actions: { receiptSeq: number }[] }
      ).actions.map((action) => action.receiptSeq),
    ).toEqual([11, 22]);
    expect(messagesA).toContainEqual(
      expect.objectContaining({
        type: 'RoundResolved',
        payload: expect.objectContaining({ closeReason: 'all-submitted' }),
      }),
    );
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
