import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomStateSchema } from '@game/schema';
import { execute } from '@game/rules-engine/room-tools';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease, type Lease } from '../../src/room/lease.js';
import { recoverRoom } from '../../src/room/recovery.js';
import { Room } from '../../src/room/Room.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { mergeCombatOutput } from '../../src/room/productionTurnRunner.js';
import {
  createCombatRuntime,
  type RoomCombatState,
} from '../../src/room/combat.js';
import { catalog, hero, preCombatGame } from '../room/combatFixtures.js';
import { scriptedDm } from '../room/scriptedDm.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const pool = new Pool({ connectionString: databaseUrl });
const log = () => {};
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;
const accountIds: string[] = [];
const sessionIds: string[] = [];
const rooms: Room[] = [];
const SECRETS = ['SecretName', 'SecretText', 'SecretNarr'];
const node = 'load-test-node';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.LLM_FIXTURE_MODE = 'strict';
});

afterEach(async () => {
  for (const room of rooms.splice(0)) await room.drain();
});

afterAll(async () => {
  for (const id of sessionIds.splice(0))
    await q('SELECT purge_session($1)', [id]);
  for (const id of accountIds.splice(0))
    await q('DELETE FROM legal_holds WHERE item_id=$1', [id]);
  for (const id of accountIds.splice(0))
    await q('DELETE FROM accounts WHERE id=$1', [id]);
  await pool.end();
});

async function account(status: string, name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h',$3,$4,true,now(),'v1',now(),now())",
    [id, `${id}@example.test`, name, status],
  );
  accountIds.push(id);
  return id;
}

/** A three-seat room mid-combat, persisted as the production runner would: GameStateCommitted events plus a snapshot. */
async function seedCombatRoom(opts: {
  clarification: boolean;
  shape?: 'only-entry' | 'no-party';
}) {
  const gone = await account('deleting', 'SecretName');
  const heir = await account('active', 'Heir');
  const third = await account('active', 'Third');
  const session = randomUUID();
  sessionIds.push(session);
  const seats = [gone, heir, third].map((accountId, i) => ({
    seatId: randomUUID(),
    accountId,
    displayName: ['SecretName', 'Heir', 'Third'][i]!,
    presence: 'online' as const,
  }));
  const chars = [
    { ...hero, id: `ent_${randomUUID()}`, name: 'SecretChar' },
    { ...hero, id: `ent_${randomUUID()}`, name: 'Heir char' },
    { ...hero, id: `ent_${randomUUID()}`, name: 'Third char' },
  ];
  const base = preCombatGame(hero).gameEngine;
  const started = execute(
    {
      ...base,
      actors: Object.fromEntries(chars.map((c) => [c.id, c])),
      hp: Object.fromEntries(chars.map((c) => [c.id, 30])),
      ac: Object.fromEntries(chars.map((c) => [c.id, 12])),
      catalog,
    } as never,
    {
      name: 'start_combat',
      args: {
        enemies: [{ monsterId: 'srd:monster/goblin-minion', count: 2 }],
        ambushSide: 'party',
      },
    },
    7,
  );
  if (!started.ok) throw new Error(started.error);
  const engineGame = {
    characters: {
      [gone]: chars[0],
      [heir]: chars[1],
      [third]: chars[2],
    },
    gameEngine: mergeCombatOutput(
      {
        ...base,
        actors: Object.fromEntries(chars.map((c) => [c.id, c])),
        hp: Object.fromEntries(chars.map((c) => [c.id, 30])),
        ac: Object.fromEntries(chars.map((c) => [c.id, 12])),
      },
      'start_combat',
      started.value,
    ),
  };
  const rec = createCombatRuntime(catalog).reconcile(engineGame, 1_000);
  if (!rec) throw new Error('combat was not bootstrapped');
  const gameState = rec.gameState as {
    combatRoom: RoomCombatState;
    combatActors: Record<string, string>;
    [key: string]: unknown;
  };
  // The deleted player's character acts first, so the deletion lands on its turn.
  gameState.combatRoom.combat.activeEntityId = chars[0]!.id;
  if (opts.shape) {
    const keep = (e: { id: string; team?: string }) =>
      e.id === chars[0]!.id ||
      (opts.shape === 'no-party' && e.team !== 'party');
    const room = gameState.combatRoom;
    room.entities = room.entities.filter(keep);
    room.combat.initiative = room.combat.initiative.filter((i) =>
      room.entities.some((e) => e.id === i.entityId),
    );
  }
  const clarifyAction = randomUUID();
  const openClarifications = opts.clarification
    ? {
        [clarifyAction]: {
          accountId: gone,
          playerName: 'SecretName',
          text: 'SecretText',
          question: 'Which door?',
          deadlineAt: Date.now() + 600_000,
        },
      }
    : undefined;
  const state = {
    ...gameState,
    lastPlayerText: 'SecretText',
    ...(openClarifications ? { openClarifications } : {}),
  };
  const roomState = {
    sessionId: session,
    phase: 'lobby',
    seats,
    gameState: state,
    actionIds: [],
    ...(openClarifications ? { openClarifications } : {}),
  };
  await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
    session,
    gone,
    'Crypt',
  ]);
  const events: [number, string, Record<string, unknown>][] = [
    [1, 'SeatJoined', seats[0]!],
    [2, 'SeatJoined', seats[1]!],
    [3, 'SeatJoined', seats[2]!],
    [4, 'GameStateCommitted', { gameState: state }],
  ];
  if (opts.clarification)
    events.push([
      5,
      'ClarificationRequested',
      {
        actionId: clarifyAction,
        accountId: gone,
        playerName: 'SecretName',
        text: 'SecretText',
        question: 'Which door?',
      },
    ]);
  for (const [seq, type, payload] of events)
    await q(
      'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$1,$3,$4)',
      [session, seq, type, payload],
    );
  await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,$2,$3)', [
    session,
    events.length,
    roomState,
  ]);
  return {
    gone,
    heir,
    third,
    session,
    seats,
    charIds: chars.map((c) => c.id),
    goneChar: chars[0]!.id,
    clarifyAction,
  };
}

async function sweep() {
  const store = new LocalObjectStore(
    await mkdtemp(join(tmpdir(), 'acct-load-')),
  );
  await runSweep(pool, { store, log });
}

/** The production load path: loadLatest -> recoverRoom -> new Room (fresh process). */
async function reload(session: string) {
  const persistence = new Persistence(pool);
  const lease = (await new SessionLease(pool).acquire(session, node)) as Lease;
  expect(lease).not.toBeNull();
  const latest = await persistence.loadLatest(session);
  const recovered = recoverRoom(session, latest);
  RoomStateSchema.parse(recovered.state);
  const runner = new ProductionSoloTurnRunner(
    pool,
    undefined,
    'strict',
    'unused.ndjson',
    scriptedDm([]),
  );
  const room = new Room(persistence, lease, latest, runner);
  rooms.push(room);
  return room;
}

const combatOf = (room: Room) =>
  (room.state.gameState as { combatRoom: RoomCombatState }).combatRoom;

async function settle(room: Room) {
  const busy = room as unknown as {
    turnInFlight: boolean;
    activeTurn: Promise<void>;
  };
  for (let i = 0; i < 200 && busy.turnInFlight; i++)
    await new Promise((r) => setTimeout(r, 25));
  await busy.activeTurn;
}

describe('account deletion: the scrubbed room still loads and plays', () => {
  it('loads with a pending clarification from the deleted seat', async () => {
    const f = await seedCombatRoom({ clarification: true });
    await sweep();
    const room = await reload(f.session);
    expect(room.state.seats.map((s) => s.displayName)).toContain(
      'Deleted player',
    );
    expect(room.state.openClarifications ?? {}).not.toHaveProperty(
      f.clarifyAction,
    );
    const dump = JSON.stringify(
      await q('SELECT payload FROM events WHERE session_id=$1', [f.session]),
    );
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
  });

  it('a turn submitted after the load runs and the heir can act in combat', async () => {
    const f = await seedCombatRoom({ clarification: true });
    await sweep();
    const room = await reload(f.session);
    const actionId = randomUUID();
    await room.submitAction(f.heir, actionId, 'I look around');
    await settle(room);
    expect(room.seq).toBeGreaterThan(4);
  });

  it('the deleted character does not hold the combat turn; combat keeps moving', async () => {
    const f = await seedCombatRoom({ clarification: false });
    await sweep();
    const room = await reload(f.session);
    const combat = combatOf(room);
    const ids = combat.entities.map((e) => e.id);
    expect(ids).not.toContain(f.goneChar);
    expect(combat.combat.initiative.map((i) => i.entityId)).not.toContain(
      f.goneChar,
    );
    expect(combat.combat.activeEntityId).not.toBe(f.goneChar);
    expect(ids).toContain(combat.combat.activeEntityId);
    const live = [f.heir, f.third];
    const startRound = combat.combat.round;
    let steps = 0;
    while (combatOf(room).combat.round < startRound + 2 && steps++ < 20) {
      const current = combatOf(room).combat.activeEntityId!;
      const actorAccount = Object.entries(
        (room.state.gameState as { combatActors: Record<string, string> })
          .combatActors,
      ).find(([, entity]) => entity === current)?.[0];
      if (!actorAccount) {
        expect(ids).toContain(current);
        await settle(room);
        continue;
      }
      expect(live).toContain(actorAccount);
      await room.submitCombatCommand(actorAccount, randomUUID(), {
        command: 'end-turn',
      });
      await settle(room);
      expect(combatOf(room).combat.activeEntityId).not.toBe(current);
    }
    expect(combatOf(room).combat.round).toBeGreaterThanOrEqual(startRound + 2);
  });
});

/** A session the deleted account only joined (owned by someone else), with player text in a commit. */
async function seedJoinedSession(gone: string, heir: string) {
  const session = randomUUID();
  sessionIds.push(session);
  const seat = {
    seatId: randomUUID(),
    accountId: gone,
    displayName: 'SecretName',
    presence: 'online',
  };
  await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
    session,
    heir,
    'Tavern',
  ]);
  await q(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,$2,$3)',
    [session, 'SeatJoined', seat],
  );
  await q(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,2,$1,$2,$3)',
    [
      session,
      'GameStateCommitted',
      { gameState: { lastPlayerText: 'SecretText', turn: 1 } },
    ],
  );
  return session;
}

describe('account deletion: holds, idempotence, and nested checkpoints', () => {
  it('a legal hold on a non-owned session defers the scrub; the account stays deleting until release', async () => {
    const gone = await account('deleting', 'SecretName');
    const heir = await account('active', 'Heir');
    const session = await seedJoinedSession(gone, heir);
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
      session,
    ]);
    await sweep();
    expect(
      (await q('SELECT status FROM accounts WHERE id=$1', [gone]))[0]?.status,
    ).toBe('deleting');
    expect(
      JSON.stringify(
        await q('SELECT payload FROM events WHERE session_id=$1', [session]),
      ),
    ).toContain(gone);
    await q("DELETE FROM legal_holds WHERE kind='session' AND item_id=$1", [
      session,
    ]);
    await sweep();
    expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toHaveLength(
      0,
    );
    const dump = JSON.stringify(
      await q('SELECT payload FROM events WHERE session_id=$1', [session]),
    );
    expect(dump).not.toContain(gone);
    expect(dump).not.toContain('SecretText');
  });

  it('scrubs lastPlayerText from a commit that carries no account id', async () => {
    const gone = await account('deleting', 'SecretName');
    const heir = await account('active', 'Heir');
    const session = await seedJoinedSession(gone, heir);
    await sweep();
    const dump = JSON.stringify(
      await q('SELECT payload FROM events WHERE session_id=$1 AND type=$2', [
        session,
        'GameStateCommitted',
      ]),
    );
    expect(dump).not.toContain('SecretText');
    expect(dump).toContain('"turn"');
  });

  it('a second sweep after deletion is a no-op', async () => {
    const f = await seedCombatRoom({ clarification: true });
    await sweep();
    await sweep();
    expect(
      await q('SELECT 1 FROM accounts WHERE id=$1', [f.gone]),
    ).toHaveLength(0);
    expect(
      await q("SELECT 1 FROM accounts WHERE status='deleting'"),
    ).toHaveLength(0);
    await reload(f.session);
  });

  it('nested checkpoints stay schema-valid and carry no deleted seat data', async () => {
    const f = await seedCombatRoom({ clarification: true });
    await q(
      `UPDATE snapshots SET state = jsonb_set(state, '{gameState,checkpoint}', $2::jsonb)
         WHERE session_id=$1`,
      [
        f.session,
        JSON.stringify({
          openClarifications: {
            [f.clarifyAction]: {
              accountId: f.gone,
              playerName: 'SecretName',
              text: 'SecretText',
              question: 'Which door?',
              deadlineAt: Date.now() + 600_000,
            },
          },
          lastPlayerText: 'SecretText',
        }),
      ],
    );
    await sweep();
    const room = await reload(f.session);
    const snap = JSON.stringify(
      await q('SELECT state FROM snapshots WHERE session_id=$1', [f.session]),
    );
    for (const secret of SECRETS) expect(snap).not.toContain(secret);
    expect(snap).not.toContain(f.gone);
    expect(room.state.gameState).toBeDefined();
  });
});

const stateOf = async (session: string) =>
  JSON.stringify(
    await q('SELECT state FROM snapshots WHERE session_id=$1 ORDER BY seq', [
      session,
    ]),
  ) +
  JSON.stringify(
    await q('SELECT payload FROM events WHERE session_id=$1', [session]),
  );

describe('account deletion: coordinates with live Rooms through the session lease', () => {
  const stale = (f: { session: string; gone: string }) => ({
    sessionId: f.session,
    phase: 'lobby',
    seats: [
      {
        seatId: randomUUID(),
        accountId: f.gone,
        displayName: 'SecretName',
        presence: 'online',
      },
    ],
    gameState: { lastPlayerText: 'SecretText', who: f.gone },
    actionIds: [],
  });

  it('fails closed while a live Room holds the lease; its later commit is retried clean by the next sweep', async () => {
    const f = await seedCombatRoom({ clarification: false });
    const room = await reload(f.session);
    await sweep();
    expect(
      (await q('SELECT status FROM accounts WHERE id=$1', [f.gone]))[0]?.status,
    ).toBe('deleting');
    // The Room commits stale state under its still-live lease.
    await new Persistence(pool).writeTurn(
      f.session,
      [
        {
          turnId: randomUUID(),
          type: 'GameStateCommitted',
          payload: { gameState: { who: f.gone, lastPlayerText: 'SecretText' } },
        },
      ],
      stale(f),
      { nodeId: room.lease.nodeId, epoch: room.lease.epoch },
    );
    await new SessionLease(pool).release(room.lease);
    await sweep();
    expect(
      await q('SELECT 1 FROM accounts WHERE id=$1', [f.gone]),
    ).toHaveLength(0);
    const dump = await stateOf(f.session);
    for (const secret of [...SECRETS, f.gone])
      expect(dump).not.toContain(secret);
  });

  it('a stale live-Room commit after the sweep cannot put the deleted data back', async () => {
    const f = await seedCombatRoom({ clarification: false });
    const room = await reload(f.session);
    // The Room stops heartbeating (crash, partition): the lease lapses and the sweep takes over.
    await q(
      "UPDATE session_lease SET expires_at=now() - interval '1 second' WHERE session_id=$1",
      [f.session],
    );
    await sweep();
    expect(
      await q('SELECT 1 FROM accounts WHERE id=$1', [f.gone]),
    ).toHaveLength(0);
    await expect(
      new Persistence(pool).writeTurn(
        f.session,
        [
          {
            turnId: randomUUID(),
            type: 'GameStateCommitted',
            payload: {
              gameState: { who: f.gone, lastPlayerText: 'SecretText' },
            },
          },
        ],
        stale(f),
        { nodeId: room.lease.nodeId, epoch: room.lease.epoch },
      ),
    ).rejects.toThrow('Lease fencing check failed');
    const dump = await stateOf(f.session);
    for (const secret of [...SECRETS, f.gone])
      expect(dump).not.toContain(secret);
    await reload(f.session);
  });

  it('drains the in-process Room first, then scrubs; the Room reloads the scrubbed state', async () => {
    const f = await seedCombatRoom({ clarification: false });
    const room = await reload(f.session);
    const leases = new SessionLease(pool);
    const store = new LocalObjectStore(
      await mkdtemp(join(tmpdir(), 'acct-load-')),
    );
    await runSweep(pool, {
      store,
      log,
      drainRoom: async () => {
        await room.drain();
        await leases.release(room.lease);
      },
    });
    expect(
      await q('SELECT 1 FROM accounts WHERE id=$1', [f.gone]),
    ).toHaveLength(0);
    const dump = await stateOf(f.session);
    for (const secret of [...SECRETS, f.gone])
      expect(dump).not.toContain(secret);
    await reload(f.session);
  });
});

describe('account deletion: combat left without the deleted character', () => {
  for (const shape of ['only-entry', 'no-party'] as const) {
    it(`${shape}: combat ends cleanly and the production load path still works`, async () => {
      const f = await seedCombatRoom({ clarification: false, shape });
      await sweep();
      const room = await reload(f.session);
      const combat = combatOf(room);
      expect(combat.ended).toBeDefined();
      expect(combat.combat.activeEntityId).toBeNull();
      expect(combat.entities.map((e) => e.id)).not.toContain(f.goneChar);
      const before = room.seq;
      await room.submitAction(f.heir, randomUUID(), 'I look around');
      await settle(room);
      expect(room.seq).toBeGreaterThan(before);
    });
  }

  it('does not run monsters: the snapshot combat state equals the last committed event', async () => {
    const f = await seedCombatRoom({ clarification: false });
    await sweep();
    const [snap] = await q(
      'SELECT state FROM snapshots WHERE session_id=$1 ORDER BY seq DESC LIMIT 1',
      [f.session],
    );
    const [ev] = await q(
      "SELECT payload FROM events WHERE session_id=$1 AND type='GameStateCommitted' ORDER BY seq DESC LIMIT 1",
      [f.session],
    );
    expect(snap.state.gameState.combatRoom).toEqual(
      ev.payload.gameState.combatRoom,
    );
    const combat = snap.state.gameState.combatRoom as RoomCombatState;
    expect(
      combat.entities.find((e) => e.id === combat.combat.activeEntityId)?.team,
    ).toBe('party');
  });

  it('purges a room whose only seat is the deleted account instead of handing it off', async () => {
    const gone = await account('deleting', 'SecretName');
    const other = await account('deleting', 'AlsoGone');
    const session = randomUUID();
    sessionIds.push(session);
    await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
      session,
      gone,
      'Solo',
    ]);
    await q(
      'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,$2,$3),($1,2,$1,$2,$4)',
      [
        session,
        'SeatJoined',
        {
          seatId: randomUUID(),
          accountId: gone,
          displayName: 'SecretName',
          presence: 'online',
        },
        {
          seatId: randomUUID(),
          accountId: other,
          displayName: 'AlsoGone',
          presence: 'online',
        },
      ],
    );
    await sweep();
    expect(
      await q('SELECT 1 FROM sessions WHERE id=$1', [session]),
    ).toHaveLength(0);
    expect(
      await q('SELECT 1 FROM events WHERE session_id=$1', [session]),
    ).toHaveLength(0);
    expect(await q('SELECT 1 FROM accounts WHERE id=$1', [gone])).toHaveLength(
      0,
    );
  });
});
