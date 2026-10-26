import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CapturingDm } from '../sim/dm.js';
import {
  SimTable,
  eventually,
  type LogEvent,
  type SimClient,
} from '../sim/harness.js';
import {
  GOBLIN,
  combatCommand,
  liveCombat,
  pollFrom,
  startPartyCombat,
} from '../sim/combat.js';
import { seatEntityId } from '../../src/room/seatEntity.js';

// M4 gate 1 gaps in the six-client combat sim: host seat removal on the active seat's turn, and
// combat turn-timer expiry against dodge/hold and against a racing player command. Same real
// Postgres, WS ticket gate, and production RoomRegistry as sim-combat.test.ts. The turn timer's
// WS floor is 30 s and the server clock is real, so the timer scenarios wait on the server's own
// TurnOpened deadline and event-log predicates; nothing sleeps for a fixed time.

const db = new Pool({ connectionString: process.env.DATABASE_URL });
let table: SimTable | undefined;
const savedNodeEnv = process.env.NODE_ENV;

const TIMER_MS = 30_000;
const TIMER_TEST_MS = 90_000;

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
 * Who may end the turn of each combatant: every PC's seat owner, plus the goblin's controller.
 * clients[0] is the mover; clients[5] controls the goblin, so clients[1] is a plain PC and the
 * revoke scenario never gives the removed seat a monster to drive.
 */
async function ownersOf(t: SimTable): Promise<Map<string, SimClient>> {
  const room = await t.room();
  const owners = new Map<string, SimClient>([[GOBLIN, t.clients[5]!]]);
  for (const seat of room.state.seats) {
    const client = t.clients.find((c) => c.accountId === seat.accountId);
    if (client) owners.set(seatEntityId(seat.seatId), client);
  }
  return owners;
}

/** Host sets the turn timer over the real WS path. The setting applies from the next opened turn. */
async function configureTurnTimer(
  host: SimClient,
  payload: { durationMs: number | null; timeoutAction?: 'dodge' | 'hold' },
) {
  const mark = host.inbox.length;
  const actionId = host.send('ConfigureTurnTimer', payload);
  const reply = await pollFrom(
    host,
    mark,
    (frame) =>
      frame.type === 'TurnTimerConfigured' ||
      (frame.type === 'Error' && frame.payload?.actionId === actionId),
  );
  expect(reply.type, JSON.stringify(reply.payload)).toBe('TurnTimerConfigured');
}

/**
 * Ends turns until the live active entity satisfies `wanted`. Each step waits for the table to
 * leave narration, so a turn is never driven mid-resolution.
 */
async function endTurnsUntil(
  t: SimTable,
  owners: Map<string, SimClient>,
  wanted: (entityId: string) => boolean,
): Promise<string> {
  for (let turn = 0; turn < 200; turn++) {
    await eventually(async () => {
      const live = await liveCombat(t);
      return (
        live.phase !== 'narrating' &&
        owners.has(live.combat.activeEntityId ?? '')
      );
    }, 10_000);
    const active = (await liveCombat(t)).combat.activeEntityId!;
    if (wanted(active)) return active;
    const reply = await combatCommand(owners.get(active)!, {
      command: 'end-turn',
    });
    if (reply.type !== 'CombatTracker')
      throw new Error(
        `end-turn by ${active} rejected: ${JSON.stringify(reply.payload)}`,
      );
  }
  throw new Error('no matching turn within 200 end-turns');
}

/**
 * The newest TurnOpened once it is the live turn, has a server deadline, and is owned by a client.
 * The deadline comes from the server's own TurnOpened event, not from a local clock.
 */
async function timedTurn(
  t: SimTable,
  owners: Map<string, SimClient>,
  openedBefore: number,
): Promise<LogEvent> {
  let opened: LogEvent | undefined;
  await eventually(async () => {
    const turns = await t.events('TurnOpened');
    const last = turns.at(-1);
    if (turns.length <= openedBefore || !last) return false;
    if (typeof last.payload.deadline !== 'number') return false;
    if (!owners.has(last.payload.entityId)) return false;
    const live = await liveCombat(t);
    if (live.turnId !== last.payload.turnId || live.phase === 'narrating')
      return false;
    opened = last;
    return true;
  }, 15_000);
  return opened!;
}

/** Each client's most recent CombatTracker must name the same active entity as the server. */
async function expectTrackersAgree(t: SimTable, clients: SimClient[]) {
  const live = (await liveCombat(t)).combat.activeEntityId ?? null;
  for (const client of clients)
    await eventually(
      async () =>
        client.messages('CombatTracker').at(-1)?.payload?.activeEntityId ===
        live,
      5_000,
    );
}

async function timedOutFor(t: SimTable, turnId: string) {
  return (await t.events('TurnTimedOut')).filter(
    (event) => event.payload.turnId === turnId,
  );
}

/** Lifecycle TurnResolved events for one turn. Each turn resolves exactly once, so this must be 1. */
async function resolutionsFor(t: SimTable, turnId: string) {
  return (await t.events('TurnResolved')).filter(
    (event) => event.payload.turnId === turnId,
  );
}

describe('host removes a seat on that seat’s turn (host revoke mid-combat)', () => {
  // There is no separate revoke action. KickSeat is the host's only seat removal: it writes
  // SeatRevoked (cause host-kick) and closes the seat's socket. This scenario removes the seat
  // while that seat's own turn is live.
  it.each(['dodge', 'hold'] as const)(
    'the live turn resolves with the configured %s, the seat loses access, and the other clients agree',
    async (timeoutAction) => {
      const { table: t } = await startCombatTable();
      const host = t.clients[0]!;
      const victim = t.clients[1]!;
      await startPartyCombat(t, t.clients[5]!);
      const owners = await ownersOf(t);
      const victimSeat = (await t.room()).state.seats.find(
        (seat) => seat.accountId === victim.accountId,
      )!;
      const victimEntity = seatEntityId(victimSeat.seatId);

      // Timer off, so only the removal can resolve the turn. The configured action is still set.
      await configureTurnTimer(host, { durationMs: null, timeoutAction });
      await endTurnsUntil(t, owners, (id) => id === victimEntity);

      host.send('KickSeat', { seatId: victimSeat.seatId });

      await eventually(
        async () => (await t.events('SeatRevoked')).length === 1,
        5_000,
      );
      const revoked = (await t.events('SeatRevoked')).at(-1)!;
      expect(revoked.payload).toMatchObject({
        seatId: victimSeat.seatId,
        cause: 'host-kick',
      });
      await eventually(async () => victim.closeCode === 1008, 3_000);

      // The removal resolves the live turn through the mailbox, so wait for its commit.
      await eventually(
        async () => (await t.events('TurnTimedOut')).length === 1,
        5_000,
      );
      const [timedOut] = await t.events('TurnTimedOut');
      expect(timedOut!.payload).toMatchObject({
        entityId: victimEntity,
        action: timeoutAction,
      });
      const turnId = timedOut!.payload.turnId as string;
      expect(await resolutionsFor(t, turnId)).toHaveLength(1);

      // The removed seat no longer holds the turn, and the table moved on to a live entity.
      expect((await liveCombat(t)).combat.activeEntityId).not.toBe(
        victimEntity,
      );

      // Access: the removed seat cannot reconnect into the table.
      expect(await victim.reconnect()).toBe(1008);

      // Every remaining seat's last tracker names the server's live active entity.
      await expectTrackersAgree(
        t,
        t.clients.filter((c) => c !== victim),
      );
    },
    TIMER_TEST_MS,
  );
});

describe('combat turn timer expiry and resolve races', () => {
  it(
    'dodge: expiry resolves the turn once; a late command from the timed-out seat is rejected',
    async () => {
      const { table: t } = await startCombatTable();
      const host = t.clients[0]!;
      await startPartyCombat(t, t.clients[5]!);
      const owners = await ownersOf(t);
      const mover = seatEntityId(
        (await t.room()).state.seats.find(
          (seat) => seat.accountId === host.accountId,
        )!.seatId,
      );
      await configureTurnTimer(host, {
        durationMs: TIMER_MS,
        timeoutAction: 'dodge',
      });
      const openedBefore = (await t.events('TurnOpened')).length;
      await endTurnsUntil(t, owners, (id) => id !== mover);

      const opened = await timedTurn(t, owners, openedBefore);
      const turnId = opened.payload.turnId as string;
      const owner = owners.get(opened.payload.entityId)!;

      await eventually(
        async () => (await timedOutFor(t, turnId)).length === 1,
        TIMER_MS + 15_000,
      );
      const [timedOut] = await timedOutFor(t, turnId);
      expect(timedOut!.payload).toMatchObject({
        entityId: opened.payload.entityId,
        action: 'dodge',
      });
      expect(
        (await t.events('DodgeDeclared')).filter(
          (e) =>
            e.payload.entityId === opened.payload.entityId &&
            e.payload.source === 'timeout',
        ),
      ).toHaveLength(1);

      // The owner's command arrives after the turn already resolved: it is rejected, not applied again.
      const late = await combatCommand(owner, { command: 'end-turn' });
      expect(late.type, JSON.stringify(late.payload)).toBe('Error');
      expect(late.payload.code).toBe('not-your-turn');

      await eventually(
        async () => (await resolutionsFor(t, turnId)).length >= 1,
        5_000,
      );
      expect(await resolutionsFor(t, turnId)).toHaveLength(1);
      expect(await timedOutFor(t, turnId)).toHaveLength(1);
      await expectTrackersAgree(t, t.clients);
    },
    TIMER_TEST_MS,
  );

  it(
    'hold: expiry resolves the turn once with hold and no dodge',
    async () => {
      const { table: t } = await startCombatTable();
      const host = t.clients[0]!;
      await startPartyCombat(t, t.clients[5]!);
      const owners = await ownersOf(t);
      const mover = seatEntityId(
        (await t.room()).state.seats.find(
          (seat) => seat.accountId === host.accountId,
        )!.seatId,
      );
      await configureTurnTimer(host, {
        durationMs: TIMER_MS,
        timeoutAction: 'hold',
      });
      const openedBefore = (await t.events('TurnOpened')).length;
      await endTurnsUntil(t, owners, (id) => id !== mover);

      const opened = await timedTurn(t, owners, openedBefore);
      const turnId = opened.payload.turnId as string;

      await eventually(
        async () => (await timedOutFor(t, turnId)).length === 1,
        TIMER_MS + 15_000,
      );
      const [timedOut] = await timedOutFor(t, turnId);
      expect(timedOut!.payload).toMatchObject({
        entityId: opened.payload.entityId,
        action: 'hold',
      });
      expect(
        (await t.events('DodgeDeclared')).filter(
          (e) => e.payload.entityId === opened.payload.entityId,
        ),
      ).toHaveLength(0);
      expect(await resolutionsFor(t, turnId)).toHaveLength(1);
      await expectTrackersAgree(t, t.clients);
    },
    TIMER_TEST_MS,
  );

  it(
    'race: a player end-turn landing on the deadline edge gives exactly one resolution',
    async () => {
      const { table: t } = await startCombatTable();
      const host = t.clients[0]!;
      await startPartyCombat(t, t.clients[5]!);
      const owners = await ownersOf(t);
      const mover = seatEntityId(
        (await t.room()).state.seats.find(
          (seat) => seat.accountId === host.accountId,
        )!.seatId,
      );
      await configureTurnTimer(host, {
        durationMs: TIMER_MS,
        timeoutAction: 'dodge',
      });
      const openedBefore = (await t.events('TurnOpened')).length;
      await endTurnsUntil(t, owners, (id) => id !== mover);

      const opened = await timedTurn(t, owners, openedBefore);
      const turnId = opened.payload.turnId as string;
      const owner = owners.get(opened.payload.entityId)!;
      const deadline = opened.payload.deadline as number;

      // Wait until the deadline is about to pass, then send the player's command.
      await eventually(
        async () => Date.now() >= deadline - 20,
        TIMER_MS + 5_000,
      );
      const reply = await combatCommand(owner, { command: 'end-turn' });

      await eventually(
        async () => (await resolutionsFor(t, turnId)).length >= 1,
        10_000,
      );
      // Whichever side won, the turn resolved exactly once and the loser was not applied.
      expect(await resolutionsFor(t, turnId)).toHaveLength(1);
      const timedOut = await timedOutFor(t, turnId);
      expect(timedOut.length).toBeLessThanOrEqual(1);
      if (timedOut.length === 1)
        expect(reply.type, JSON.stringify(reply.payload)).toBe('Error');
      else
        expect(reply.type, JSON.stringify(reply.payload)).toBe('CombatTracker');
      await expectTrackersAgree(t, t.clients);
    },
    TIMER_TEST_MS,
  );
});
