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

function recorder(): Connection & {
  sent: { type: string; payload?: unknown }[];
} {
  const sent: { type: string; payload?: unknown }[] = [];
  return {
    sent,
    send(message) {
      sent.push(message as { type: string; payload?: unknown });
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(
  runner: SoloTurnRunner,
  options: { abortEnabled?: boolean } = {},
) {
  const events: StoredEvent[] = [];
  const store: RoomStore & {
    xCardAbortEnabled?(id: string): Promise<boolean>;
  } = {
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id, inputs) {
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
    async xCardAbortEnabled() {
      return options.abortEnabled ?? false;
    },
  };
  const room = new Room(store, lease, { snapshot: null, events: [] }, runner);
  return { room, events };
}

const seatIdOf = (events: StoredEvent[], accountId: string): string => {
  const joined = events.find(
    (event) =>
      event.type === 'SeatJoined' &&
      (event.payload as { accountId: string }).accountId === accountId,
  );
  return (joined!.payload as { seatId: string }).seatId;
};

const completingRunner = (requests: SoloTurnRequest[]): SoloTurnRunner => ({
  async run(request, onEvent) {
    requests.push(request);
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
});

describe('X-card', () => {
  it('broadcasts an anonymized SafetyFlag that carries no seat identifier', async () => {
    const owner = randomUUID();
    const other = recorder();
    const { room, events } = setup(completingRunner([]));
    const ownerConn = recorder();
    await joinSeated(room, owner, ownerConn, 'Owner');
    await joinSeated(room, randomUUID(), other, 'Other');
    const seatId = seatIdOf(events, owner);

    const otherBefore = other.sent.length;
    const ownerBefore = ownerConn.sent.length;
    await room.xCard(owner);

    const flags = other.sent.filter((m) => m.type === 'SafetyFlag');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.payload).toEqual({ kind: 'x-card' });
    expect(JSON.stringify(other.sent.slice(otherBefore))).not.toContain(seatId);
    expect(JSON.stringify(ownerConn.sent.slice(ownerBefore))).not.toContain(
      seatId,
    );
    expect(events.find((e) => e.type === 'SafetyFlag')).toBeDefined();
  });

  it('steers the next prompt away once, then stops', async () => {
    const owner = randomUUID();
    const requests: SoloTurnRequest[] = [];
    const { room } = setup(completingRunner(requests));
    await joinSeated(room, owner, recorder(), 'Owner');

    await room.xCard(owner);
    await room.submitAction(owner, randomUUID(), 'Next move.', 'Owner');
    await settle();
    await room.submitAction(owner, randomUUID(), 'Another move.', 'Owner');
    await settle();

    expect(requests[0]?.steerAway).toBe(true);
    expect(requests[1]?.steerAway).toBe(false);
  });

  it('aborts an in-flight generation only when the host enables it', async () => {
    for (const abortEnabled of [false, true]) {
      const owner = randomUUID();
      const started = gate();
      const release = gate();
      let aborted = false;
      const runner: SoloTurnRunner = {
        async run(request, onEvent) {
          started.open();
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) =>
              request.signal?.addEventListener('abort', () => {
                aborted = true;
                resolve();
              }),
            ),
          ]);
          onEvent({ type: 'NarrationCompleted', narration: 'ok' });
          return {
            narration: 'ok',
            events: [{ type: 'TurnStarted', turnId: 't1' }],
            state: {},
            turnSeed: '0x0000000000000001',
            usage: { in: 1, out: 1 },
          };
        },
      };
      const { room } = setup(runner, { abortEnabled });
      await joinSeated(room, owner, recorder(), 'Owner');
      const submitted = room.submitAction(
        owner,
        randomUUID(),
        'We look around.',
        'Owner',
      );
      await started.promise;

      await room.xCard(owner);
      await settle();
      release.open();
      await submitted;
      await settle();

      expect(aborted).toBe(abortEnabled);
    }
  });
});
