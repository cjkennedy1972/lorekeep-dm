import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingDm } from '../sim/dm.js';
import { SimTable, eventually, type SimClient } from '../sim/harness.js';
import {
  combatCommand,
  framesOf,
  pollFrom,
  startPartyCombat,
} from '../sim/combat.js';
import { seatEntityId } from '../../src/room/seatEntity.js';

// Six-client party combat over real Postgres, the real WS ticket gate, and the production
// RoomRegistry. The DM is scripted (CapturingDm); no network or model is used. Each scenario
// starts real combat through startPartyCombat, so the event log and frames are the server's own.

const db = new Pool({ connectionString: process.env.DATABASE_URL });
let table: SimTable | undefined;
const savedNodeEnv = process.env.NODE_ENV;

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  process.env.NODE_ENV = 'test';
});
afterEach(async () => {
  await table?.stop();
  table = undefined;
});
afterAll(async () => {
  await db.end();
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

/** Six seated clients, all connected, with a fresh CapturingDm. */
async function startCombatTable() {
  const dm = new CapturingDm();
  table = await SimTable.start(db, { players: 6, dm: dm.adapter() });
  for (const client of table.clients) {
    expect(await client.connect()).toBeUndefined();
  }
  return { table, dm };
}

/**
 * The mover steps out of goblin 1's reach, opening one reaction window for the goblin's
 * controller. Returns the prompt frame the controller received.
 */
async function provokeReaction(
  mover: SimClient,
  controller: SimClient,
  leaveTo: { x: number; y: number },
) {
  const mark = controller.inbox.length;
  const moved = await combatCommand(mover, {
    command: 'move',
    destination: leaveTo,
  });
  expect(moved.type, JSON.stringify(moved.payload)).toBe('CombatTracker');
  return pollFrom(controller, mark, (frame) => frame.type === 'ReactionPrompt');
}

describe('reaction timeout', () => {
  it('declines at the 15 s window with cause timeout and never answers', async () => {
    const { table: t } = await startCombatTable();
    const [mover, controller] = t.clients as [SimClient, SimClient];
    const { leaveTo } = await startPartyCombat(t, controller);

    const prompt = await provokeReaction(mover, controller, leaveTo);
    expect(prompt.payload.timeoutMs).toBeGreaterThan(0);
    expect(prompt.payload.timeoutMs).toBeLessThanOrEqual(15_000);

    await eventually(
      async () => (await t.events('ReactionDeclined')).length === 1,
      20_000,
    );
    const [declined] = await t.events('ReactionDeclined');
    expect(declined!.payload.cause).toBe('timeout');
    expect(await t.events('ReactionAnswered')).toHaveLength(0);
  }, 40_000);
});

describe('reconnect mid-prompt', () => {
  it('replays the still-open prompt with remaining time after a reconnect, and the drop does not decline it', async () => {
    const { table: t } = await startCombatTable();
    const [mover, controller] = t.clients as [SimClient, SimClient];
    const { leaveTo } = await startPartyCombat(t, controller);

    await provokeReaction(mover, controller, leaveTo);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const resumeMark = controller.inbox.length;
    expect(await controller.reconnect()).toBeUndefined();
    const replayed = await pollFrom(
      controller,
      resumeMark,
      (frame) => frame.type === 'ReactionPrompt',
      5_000,
    );
    expect(replayed.payload.timeoutMs).toBeGreaterThan(0);
    expect(replayed.payload.timeoutMs).toBeLessThan(14_000);
    expect(await t.events('ReactionDeclined')).toHaveLength(0);
  }, 40_000);

  // Known product gap (see Workboard card for M4-9a). Room derives a seated account's actor from
  // its own party seat (Room.ts actorId derivation), so the controller a monster is bound to via
  // combatActors is always rejected as not-your-turn. The prompt reaches them; the answer cannot.
  // Pinned to the exact current rejection, not to any failure. A plain `it` (not it.fails) is used
  // so a timeout or broken helper fails this test instead of passing it. When the gap is fixed the
  // answer becomes a CombatTracker, this assertion fails, and the test should be rewritten to expect success.
  it('pins the monster-bound controller reaction answer as rejected with not-your-turn after reconnect', async () => {
    const { table: t } = await startCombatTable();
    const [mover, controller] = t.clients as [SimClient, SimClient];
    const { leaveTo } = await startPartyCombat(t, controller);

    await provokeReaction(mover, controller, leaveTo);
    expect(await controller.reconnect()).toBeUndefined();
    const replayed = await pollFrom(
      controller,
      0,
      (frame) => frame.type === 'ReactionPrompt',
      5_000,
    );
    const answer = await combatCommand(controller, {
      command: 'reaction',
      reactionId: replayed.payload.reactionId as string,
      choice: 'decline',
    });
    expect(answer.type).toBe('Error');
    expect(answer.payload?.code).toBe('not-your-turn');
  }, 40_000);
});

describe('chat isolation from combat narration', () => {
  it('keeps out-of-character chat out of combat narration prompts while other seats still receive it', async () => {
    const { table: t, dm } = await startCombatTable();
    const [mover, controller, chatter, listener] = t.clients as [
      SimClient,
      SimClient,
      SimClient,
      SimClient,
    ];
    await startPartyCombat(t, controller);

    const marker = 'OOC-SIM-MARKER-7f3a';
    const listenMark = listener.inbox.length;
    chatter.chat(marker);
    const received = await pollFrom(
      listener,
      listenMark,
      (frame) => frame.type === 'ChatMessage' && frame.payload?.text === marker,
      5_000,
    );
    expect(received.payload.text).toBe(marker);

    // Narration follows a turn end here: the move-only path does not reach the DM in this setup.
    const ended = await combatCommand(mover, { command: 'end-turn' });
    expect(ended.type, JSON.stringify(ended.payload)).toBe('CombatTracker');
    // Narration is queued after the reply, so wait for the DM to actually be asked before checking.
    await eventually(async () => dm.requests.length > 0, 10_000);
    expect(dm.promptText()).not.toContain(marker);
  }, 40_000);
});

describe('host kick during an open reaction prompt', () => {
  it('declines immediately with cause presence, closes the kicked socket 1008, and does not stall', async () => {
    const { table: t } = await startCombatTable();
    const [host, controller] = t.clients as [SimClient, SimClient];
    const { leaveTo } = await startPartyCombat(t, controller);

    await provokeReaction(host, controller, leaveTo);

    const room = await t.room();
    const controllerSeat = room.state.seats.find(
      (seat) => seat.accountId === controller.accountId,
    )!;
    const kickedAt = Date.now();
    host.send('KickSeat', { seatId: controllerSeat.seatId });

    await eventually(
      async () => (await t.events('ReactionDeclined')).length === 1,
      3_000,
    );
    expect(Date.now() - kickedAt).toBeLessThan(3_000);
    const [declined] = await t.events('ReactionDeclined');
    expect(declined!.payload.cause).toBe('presence');
    expect(await t.events('ReactionAnswered')).toHaveLength(0);

    await eventually(async () => controller.closeCode === 1008, 3_000);
    const after = await combatCommand(host, { command: 'end-turn' });
    expect(after.type, JSON.stringify(after.payload)).toBe('CombatTracker');
  }, 40_000);
});

describe('spotlight over combat turns', () => {
  it('gives every PC still standing a turn in every complete round, across six clients', async () => {
    const { table: t } = await startCombatTable();
    const controller = t.clients[1]!;
    const { mover } = await startPartyCombat(t, controller);
    const room = await t.room();

    // Map each PC's entity to its client so the owning seat ends its own turn.
    const clientByEntity = new Map<string, SimClient>();
    for (const seat of room.state.seats) {
      const client = t.clients.find((c) => c.accountId === seat.accountId);
      if (client) clientByEntity.set(seatEntityId(seat.seatId), client);
    }
    const pcEntities = [...clientByEntity.keys()];
    expect(pcEntities).toHaveLength(6);

    // Drive from the tracker replies: each one names whose turn is next. Monster turns resolve
    // on the server, so only PC turns are ended here.
    let active: string | null = mover;
    for (let turn = 0; turn < 200 && active; turn++) {
      const owner = clientByEntity.get(active) ?? controller;
      // The tracker is broadcast to every seat, so a seat's next command could otherwise be matched
      // to the previous command's broadcast that arrives late. Record each inbox first, then wait for
      // all six to receive this command's tracker before the next command is sent.
      const marks = new Map(t.clients.map((c) => [c, c.inbox.length]));
      const reply = await combatCommand(owner, { command: 'end-turn' });
      if (reply.type !== 'CombatTracker') {
        if (String(reply.payload?.message).includes('Combat is over')) break;
        throw new Error(
          `end-turn by ${active} rejected: ${JSON.stringify(reply.payload)}`,
        );
      }
      await Promise.all(
        t.clients.map((c) =>
          pollFrom(c, marks.get(c)!, (f) => f.type === 'CombatTracker', 5_000),
        ),
      );
      active = (reply.payload?.activeEntityId ?? null) as string | null;
    }

    // Rounds come from the persisted log: a round opens at each mover turn, and a PC down at the
    // round's start, or going down during it, is not owed a turn in that round.
    const log = (await t.events()).filter((e) =>
      ['TurnStarted', 'EntityDown'].includes(e.type),
    );
    const pcSet = new Set(pcEntities);
    const down = new Set<string>();
    const rounds: {
      turners: Set<string>;
      downAtStart: Set<string>;
      downDuring: Set<string>;
    }[] = [];
    for (const e of log) {
      const id = e.payload.entityId as string;
      if (e.type === 'EntityDown') {
        down.add(id);
        rounds.at(-1)?.downDuring.add(id);
      } else if (id === mover) {
        // The mover's turn opens the round, and that turn is the mover's own.
        rounds.push({
          turners: new Set([id]),
          downAtStart: new Set(down),
          downDuring: new Set(),
        });
      } else if (pcSet.has(id)) {
        rounds.at(-1)?.turners.add(id);
      }
    }

    // The last round may be cut short by the encounter ending, so only complete rounds are judged.
    const complete = rounds.slice(0, -1);
    const starved = complete.flatMap((round, index) =>
      pcEntities
        .filter((id) => !round.downAtStart.has(id) && !round.downDuring.has(id))
        .filter((id) => !round.turners.has(id))
        .map((id) => `round ${index + 1}: ${id}`),
    );
    const outcome = (await t.events('CombatEnded')).at(-1)?.payload.outcome;
    expect(
      starved,
      `standing PCs with no turn; rounds=${rounds.length} outcome=${outcome}`,
    ).toEqual([]);
    expect(
      complete.length,
      `complete rounds observed; outcome=${outcome}`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      framesOf(t.clients[0]!, 'Error').filter(
        (f) => f.payload?.code === 'RATE_LIMITED',
      ),
    ).toHaveLength(0);
  }, 120_000);
});
