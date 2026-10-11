import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type Connection, type RoomStore } from '../../src/room/Room.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';

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

const narrationOf = (connection: { sent: { type: string }[] }) =>
  connection.sent.filter(
    (m) => m.type === 'NarrationChunk' || m.type === 'NarrationCompleted',
  );

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

/** A runner that announces the tier, streams chunks, and pauses at each `pause` point. */
function narratingRunner(
  tier: string,
  pauses: { reached: () => void; wait: Promise<void> }[],
) {
  const runner: SoloTurnRunner = {
    async run(_request, onEvent) {
      onEvent({ type: 'NarrationTier', tier });
      onEvent({ type: 'NarrationChunk', text: 'chunk-1' });
      for (const pause of pauses) {
        pause.reached();
        await pause.wait;
        onEvent({ type: 'NarrationChunk', text: 'chunk-after-pause' });
      }
      onEvent({
        type: 'NarrationCompleted',
        narration: 'chunk-1 chunk-after-pause',
      });
      return {
        narration: 'chunk-1 chunk-after-pause',
        events: [{ type: 'TurnStarted', turnId: 't1' }],
        state: {},
        turnSeed: '0x0000000000000001',
        usage: { in: 1, out: 1 },
      };
    },
  };
  return runner;
}

function setup(runner: SoloTurnRunner, eligible: Set<string>) {
  const events: StoredEvent[] = [];
  const store: RoomStore = {
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id, inputs, state) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      void state;
      return { events: stored };
    },
    async matureEligibleAccounts(accountIds: string[]) {
      return accountIds.filter((id) => eligible.has(id));
    },
  };
  return new Room(store, lease, { snapshot: null, events: [] }, runner);
}

describe('mature narration delivery', () => {
  it('withholds the in-flight mature turn from a connection that joins mid-narration', async () => {
    const eligible = new Set<string>();
    const owner = randomUUID();
    const joiner = randomUUID();
    eligible.add(owner).add(joiner);
    const reached = gate();
    const release = gate();
    const room = setup(
      narratingRunner('mature', [
        { reached: reached.open, wait: release.promise },
      ]),
      eligible,
    );
    const ownerConn = recorder();
    await room.join(owner, ownerConn, 'Owner');
    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await reached.promise;

    const joinerConn = recorder();
    await room.join(joiner, joinerConn, 'Joiner');
    release.open();
    await settle();

    expect(narrationOf(ownerConn).map((m) => m.type)).toEqual([
      'NarrationChunk',
      'NarrationChunk',
      'NarrationCompleted',
    ]);
    expect(narrationOf(joinerConn)).toEqual([]);
  });

  it('stops the remainder of a mature narration for a seat that opts out mid-stream', async () => {
    const eligible = new Set<string>();
    const owner = randomUUID();
    eligible.add(owner);
    const reached = gate();
    const release = gate();
    const room = setup(
      narratingRunner('mature', [
        { reached: reached.open, wait: release.promise },
      ]),
      eligible,
    );
    const ownerConn = recorder();
    await room.join(owner, ownerConn, 'Owner');
    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await reached.promise;
    await settle();

    eligible.delete(owner);
    release.open();
    await settle();

    expect(narrationOf(ownerConn).map((m) => m.type)).toEqual([
      'NarrationChunk',
    ]);
  });

  it('withholds the in-flight mature turn from an opted-out seat that reconnects mid-narration', async () => {
    const eligible = new Set<string>();
    const owner = randomUUID();
    eligible.add(owner);
    const reached = gate();
    const release = gate();
    const room = setup(
      narratingRunner('mature', [
        { reached: reached.open, wait: release.promise },
      ]),
      eligible,
    );
    const ownerConn = recorder();
    await room.join(owner, ownerConn, 'Owner');
    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await reached.promise;

    await room.disconnect(owner);
    eligible.delete(owner);
    const reconnected = recorder();
    await room.join(owner, reconnected, 'Owner');
    release.open();
    await settle();

    expect(narrationOf(reconnected)).toEqual([]);
  });

  it('keeps delivering a non-mature narration to a connection that joins mid-narration', async () => {
    const owner = randomUUID();
    const joiner = randomUUID();
    const reached = gate();
    const release = gate();
    const room = setup(
      narratingRunner('standard', [
        { reached: reached.open, wait: release.promise },
      ]),
      new Set(),
    );
    const ownerConn = recorder();
    await room.join(owner, ownerConn, 'Owner');
    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await reached.promise;

    const joinerConn = recorder();
    await room.join(joiner, joinerConn, 'Joiner');
    release.open();
    await settle();

    expect(narrationOf(joinerConn).map((m) => m.type)).toEqual([
      'NarrationChunk',
      'NarrationCompleted',
    ]);
  });

  it('never puts narration text into a joiner catch-up snapshot', async () => {
    const owner = randomUUID();
    const joiner = randomUUID();
    const reached = gate();
    const release = gate();
    const room = setup(
      narratingRunner('mature', [
        { reached: reached.open, wait: release.promise },
      ]),
      new Set([owner]),
    );
    await room.join(owner, recorder(), 'Owner');
    await room.submitAction(owner, randomUUID(), 'We look around.', 'Owner');
    await reached.promise;

    const joinerConn = recorder();
    await room.join(joiner, joinerConn, 'Joiner');
    release.open();
    await settle();

    const snapshots = joinerConn.sent.filter((m) => m.type === 'StateSync');
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots)
      expect(JSON.stringify(snapshot)).not.toContain('chunk-1');
  });
});
