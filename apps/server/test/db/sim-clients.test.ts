import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingDm } from '../sim/dm.js';
import type { InputGate } from '../../src/safety/inputGate.js';
import {
  BLOCKED_MARKER,
  eventually,
  moderationGate,
  SimTable,
  SimClient,
} from '../sim/harness.js';
import { spotlight } from '../sim/spotlight.js';

// Scripted-table scenarios over real Postgres, the real WS ticket gate, and the production
// RoomRegistry. The DM is scripted (CapturingDm); no network or model is used.

const db = new Pool({ connectionString: process.env.DATABASE_URL });
let table: SimTable | undefined;

afterEach(async () => {
  await table?.stop();
  table = undefined;
});
// Pin NODE_ENV so the moderator uses the scripted gate, never the endpoint judge.
const savedNodeEnv = process.env.NODE_ENV;
afterAll(async () => {
  await db.end();
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});
beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  process.env.NODE_ENV = 'test';
});

/** Holds the gate decision for one text until released, so receipt order differs from acceptance order. */
function holdGate(heldText: string) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const base = moderationGate();
  const gate: InputGate = {
    ...base,
    check: async (input) => {
      if (input.text === heldText) {
        reached();
        await open;
      }
      return base.check(input);
    },
    checkDetailed: async (input) => {
      if (input.text === heldText) {
        reached();
        await open;
      }
      return base.checkDetailed(input);
    },
  };
  return { gate, atGate, release };
}

async function startTable(
  players: number,
  dm = new CapturingDm(),
  gate?: InputGate,
) {
  table = await SimTable.start(db, { players, dm: dm.adapter(), gate });
  for (const client of table.clients) {
    const closed = await client.connect();
    expect(closed).toBeUndefined();
  }
  return { table, dm };
}

async function roundIds(t: SimTable): Promise<string[]> {
  return (await t.events('RoundOpened')).map((e) => e.payload.roundId);
}

async function resolvedFor(t: SimTable, roundId: string) {
  return (await t.events('RoundResolved')).filter(
    (e) => e.payload.roundId === roundId,
  );
}

describe('simultaneous submission ordering', () => {
  it('sorts a batch by receiptSeq and includes every submitted action', async () => {
    // ADR-029 §1.3: gate decisions may complete in any order, so acceptance order is not
    // the contract. The contract is that the batch is sorted by receiptSeq.
    // alpha holds receipt 1 at the gate, so bravo and charlie are accepted first. Without the
    // sort the batch would be [2, 3, 1] in acceptance order.
    const held = holdGate('alpha');
    const { table: t } = await startTable(3, undefined, held.gate);
    const [a, b, c] = t.clients as [SimClient, SimClient, SimClient];
    const submitted = [a.submit('alpha')];
    await held.atGate;
    submitted.push(b.submit('bravo'), c.submit('charlie'));
    await eventually(
      async () => (await t.events('RoundActionAccepted')).length === 2,
    );
    held.release();
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
    const [resolved] = await t.events('RoundResolved');
    const batch = resolved!.payload.actions as {
      actionId: string;
      receiptSeq: number;
    }[];
    expect(batch).toHaveLength(3);
    const seqs = batch.map((item) => item.receiptSeq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(batch.map((item) => item.actionId).sort()).toEqual(
      [...submitted].sort(),
    );
  });
});

describe('round resolution races', () => {
  it('timer, all-in, and resolve-now give exactly one resolution', async () => {
    const { table: t } = await startTable(2);
    const [host, p2] = t.clients as [SimClient, SimClient];
    host.configureTimer(120);
    host.submit('host acts');
    p2.submit('p2 acts');
    host.resolveNow();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const [round] = await roundIds(t);
    expect(await resolvedFor(t, round!)).toHaveLength(1);
    expect(
      (await t.events('RoundClosedEmpty')).filter(
        (e) => e.payload.roundId === round,
      ),
    ).toHaveLength(0);
  });

  it('a withdrawn action never reaches the batch and the round resolves once', async () => {
    const { table: t } = await startTable(2);
    const [p1, p2] = t.clients as [SimClient, SimClient];
    const first = p1.submit('will withdraw');
    p1.withdraw(first);
    await eventually(
      async () => (await t.events('RoundActionWithdrawn')).length === 1,
    );
    // Withdrawn seat is no longer submitted, so the round must still be open.
    expect(await t.events('RoundResolved')).toHaveLength(0);
    const replacement = p1.submit('replacement');
    p2.submit('stays');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
    const [resolved] = await t.events('RoundResolved');
    const batchIds = (resolved!.payload.actions as { actionId: string }[]).map(
      (item) => item.actionId,
    );
    expect(batchIds).not.toContain(first);
    expect(batchIds).toContain(replacement);
    expect(batchIds).toHaveLength(2);
  });
});

describe('queueing during resolving', () => {
  it('queues an action sent while the batch is resolving and promotes it', async () => {
    const dm = new CapturingDm();
    const { table: t } = await startTable(2, dm);
    const [p1, p2] = t.clients as [SimClient, SimClient];
    dm.hold();
    p1.submit('first');
    p2.submit('second');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
    const queued = p1.submit('queued during resolve');
    await eventually(async () =>
      (await t.events('RoundActionAccepted')).some(
        (e) =>
          e.payload.queued === true && e.payload.submission.actionId === queued,
      ),
    );
    dm.release();
    await eventually(async () => (await roundIds(t)).length >= 2);
    // The durable RoundOpened payload is the round object; promoted items sit in submissions.
    const opened = (await t.events('RoundOpened'))[1]!;
    expect(
      (opened.payload.submissions as { actionId: string }[]).map(
        (x) => x.actionId,
      ),
    ).toContain(queued);
    p2.submit('second round');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 2,
    );
    const [, second] = await t.events('RoundResolved');
    expect(
      (second!.payload.actions as { actionId: string }[]).map(
        (x) => x.actionId,
      ),
    ).toContain(queued);
  });
});

describe('ws-ticket abrupt socket recovery repro', () => {
  it('resumes after a completed round when a killed client leaves an active-socket claim', async () => {
    const { table: t } = await startTable(2);
    const [owner, guest] = t.clients as [SimClient, SimClient];

    // Exercise the owner path after actual gameplay, not just a lobby connection.
    owner.submit('I search the room');
    guest.submit('I watch the doorway');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );

    // (d) A second socket for the same seat is refused while the first is live.
    const duplicate = new SimClient(
      t,
      owner.accountId,
      t.tokenFor(0),
      'Duplicate owner socket',
    );
    expect(await duplicate.connect()).toBe(1008);

    // (a) Abrupt client death sends no close frame. Recreate the stale DB claim
    // after the real gateway's close handler runs to model a lost close notification
    // (e), then let its 15-second heartbeat lease expire as production does (b).
    owner.terminate();
    expect(await owner.waitForClose()).toBe(1006);
    const room = await t.room();
    const seatId = room.state.seats.find(
      (seat) => seat.accountId === owner.accountId,
    )!.seatId;
    await eventually(async () => {
      const result = await db.query<{ active_socket_id: string | null }>(
        'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
        [t.sessionId, seatId],
      );
      return result.rows[0]?.active_socket_id === null;
    });
    await db.query(
      `UPDATE seat_resume_tokens
          SET active_socket_id=$3,heartbeat_at=clock_timestamp()
        WHERE session_id=$1 AND seat_id=$2`,
      [t.sessionId, seatId, randomUUID()],
    );

    // The dead socket's still-live claim refuses a resume at first (e), rather
    // than letting a second controller take over before the lease expires.
    expect(await owner.connect()).toBe(1008);
    await new Promise((resolve) => setTimeout(resolve, 15_250));

    // (c) The real HTTP ticket route issues a ticket and the production WS gateway
    // accepts the owner's retained resume proof after the stale claim expires.
    expect(await owner.connect()).toBeUndefined();
    await owner.waitForType('SeatAuthenticated');
    await owner.waitForType('StateSync');
    const active = await db.query<{ active_socket_id: string | null }>(
      'SELECT active_socket_id FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
      [t.sessionId, seatId],
    );
    expect(active.rows[0]?.active_socket_id).toBeTruthy();
  }, 30_000);
});

describe('reconnect', () => {
  it('re-syncs an in-flight submission and keeps it in the next batch', async () => {
    const { table: t } = await startTable(2);
    const [p1, p2] = t.clients as [SimClient, SimClient];
    const mine = p1.submit('before drop');
    await eventually(
      async () => (await t.events('RoundActionAccepted')).length === 1,
    );
    const syncsBefore = p1.messages('StateSync').length;
    expect(await p1.reconnect()).toBeUndefined();
    expect(p1.messages('StateSync').length).toBeGreaterThan(syncsBefore);
    p2.submit('after');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
    const [resolved] = await t.events('RoundResolved');
    expect(
      (resolved!.payload.actions as { actionId: string }[]).map(
        (x) => x.actionId,
      ),
    ).toContain(mine);
  });
});

describe('host-only actions', () => {
  it('lets only the host configure the timer or resolve now', async () => {
    const { table: t } = await startTable(2);
    const [host, p2] = t.clients as [SimClient, SimClient];
    p2.configureTimer(50);
    p2.resolveNow();
    await p2.waitForType('Error', 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await t.events('RoundTimerConfigured')).toHaveLength(0);
    expect(await t.events('RoundResolved')).toHaveLength(0);

    host.configureTimer(null);
    await eventually(
      async () => (await t.events('RoundTimerConfigured')).length === 1,
    );
    host.submit('host only');
    host.resolveNow();
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
  });
});

describe('moderation', () => {
  it('gives a sender a neutral private rejection and leaks nothing to others', async () => {
    const { table: t } = await startTable(2);
    const [p1, p2] = t.clients as [SimClient, SimClient];
    const id = p1.submit(`${BLOCKED_MARKER} bad text`);
    const error = await p1.waitFor(
      (f) => f.type === 'Error' && f.payload.actionId === id,
    );
    expect(error.payload.code).toBe('CONTENT_REJECTED');
    expect(error.payload.message).toBe('That action cannot be sent.');
    p1.chat(`${BLOCKED_MARKER} chat`);
    await p1.waitFor(
      (f) => f.type === 'Error' && f.payload.code === 'CHAT_REJECTED',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const frame of p2.inbox)
      expect(JSON.stringify(frame)).not.toContain(BLOCKED_MARKER);
    expect(JSON.stringify(await t.events())).not.toContain(BLOCKED_MARKER);
  });
});

describe('OOC chat isolation', () => {
  it('never reaches a DM prompt or narration', async () => {
    const marker = `OOC-MARKER-${randomUUID()}`;
    const dm = new CapturingDm();
    const { table: t } = await startTable(2, dm);
    const [p1, p2] = t.clients as [SimClient, SimClient];
    p1.chat(`${marker} out of character`);
    await p2.waitFor(
      (f) => f.type === 'ChatMessage' && f.payload.text?.includes(marker),
    );
    p1.submit('I open the door');
    p2.submit('I wait by the wall');
    await eventually(
      async () => (await t.events('RoundResolved')).length === 1,
    );
    // The DM request is made after RoundResolved is written, so wait for it.
    await eventually(async () => dm.requests.length > 0);
    // Player text is base64 inside PLAYER_DATA blocks, so decode them before the substring check.
    const decoded = dm.decodedPlayerText();
    // Positive control: the decoder sees the player actions, so an empty result cannot pass.
    expect(decoded).toContain('I open the door');
    expect(decoded).toContain('I wait by the wall');
    expect(decoded).not.toContain(marker);
    expect(dm.promptText()).not.toContain(marker);
    for (const client of t.clients)
      for (const frame of client.inbox)
        if (frame.type !== 'ChatMessage' && frame.type !== 'ChatHistory')
          expect(JSON.stringify(frame)).not.toContain(marker);
    expect(JSON.stringify(await t.events('RoundResolved'))).not.toContain(
      marker,
    );
  });
});

describe('revoked seat', () => {
  it('cannot reconnect, submit, or read chat after leaving', async () => {
    const { table: t } = await startTable(3);
    const [, , p3] = t.clients as [SimClient, SimClient, SimClient];
    const room = await t.room();
    await room.leave(p3.accountId);
    await eventually(async () => p3.closeCode !== undefined);
    expect(await p3.reconnect()).toBe(1008);
    await expect(
      room.submitAction(p3.accountId, randomUUID(), 'late'),
    ).rejects.toThrow('Account is not seated');
    await expect(room.loadChatHistory(p3.accountId)).rejects.toThrow();
    expect(
      (await t.events('RoundActionAccepted')).filter(
        (e) => e.payload.submission.accountId === p3.accountId,
      ),
    ).toHaveLength(0);
  });
});

describe('spotlight from the event log', () => {
  it('gives every active player at least one direct prompt over 6 players and 10 turns', async () => {
    const dm = new CapturingDm();
    const { table: t } = await startTable(6, dm);
    for (let turn = 0; turn < 10; turn++) {
      // The gateway allows 6 submit/edit/withdraw mutations per seat per 60s
      // (Room.reserveActionMutation). Space turns at 11s so 10 turns stay under it.
      if (turn > 0) await new Promise((resolve) => setTimeout(resolve, 11_000));
      await eventually(async () => (await roundIds(t)).length >= turn + 1);
      t.clients.forEach((client, i) => client.submit(`turn ${turn} seat ${i}`));
      await eventually(
        async () => (await t.events('RoundResolved')).length >= turn + 1,
        10000,
      );
    }
    const report = await spotlight(t);
    console.log('spotlight', JSON.stringify(report));
    expect(report.activePlayers).toHaveLength(6);
    expect(report.unspotlit).toEqual([]);
  }, 180000);
});
