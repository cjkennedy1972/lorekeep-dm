import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  LeaseConflictError,
  Persistence,
  RewindRefusedError,
} from '../../src/persistence/index.js';
import { REVERTED_TURN_EXCLUSION } from '../../src/persistence/rewind.js';
import { RegistryMemory, type RegistryEvent } from '../../src/dm/memory.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL required for rewind integration tests');

async function fixture(run: (pool: Pool, sessionId: string) => Promise<void>) {
  const pool = new Pool({ connectionString: databaseUrl });
  const sessionId = randomUUID();
  try {
    await pool.query(
      'INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,$4,true,now(),$5,now())',
      [sessionId, `${sessionId}@example.test`, 'hash', 'Player', 'v1'],
    );
    await pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$1)',
      [sessionId],
    );
    await run(pool, sessionId);
  } finally {
    await pool.end();
  }
}

const ids = {
  a: randomUUID(),
  b: randomUUID(),
  pause: randomUUID(),
  r: randomUUID(),
  c: randomUUID(),
} as const;
const npc = (role: string): RegistryEvent => ({
  type: 'NpcUpserted',
  npc: {
    id: 'npc_ada',
    name: 'Ada Vale',
    role,
    disposition: 'neutral',
    facts: [],
  },
});
const revert = (revertedTurnId: string) =>
  row('r', 'TurnReverted', {
    type: 'TurnReverted',
    turnId: ids.r,
    revertedTurnId,
  });
const row = (
  turnId: keyof typeof ids,
  type: string,
  payload: unknown = {},
) => ({
  turnId: ids[turnId],
  type,
  payload,
});

describe('rewind plan', () => {
  it('targets the last resolved turn, its pre-turn snapshot, and the rewind it used', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);
      await persistence.writeTurn(
        id,
        [row('b', 'ToolCall'), row('b', 'NarrationCompleted')],
        { turn: 2 },
      );

      const plan = await persistence.loadRewindPlan(id);
      expect(plan).toMatchObject({ turnId: ids.b, rewindUsed: false });
      expect(plan!.before.snapshot).toMatchObject({
        seq: 1,
        state: { turn: 1 },
      });
      expect(plan!.before.events.map((event) => event.seq)).toEqual([2]);

      await persistence.writeTurn(
        id,
        [
          row('r', 'TurnReverted', {
            type: 'TurnReverted',
            turnId: ids.r,
            revertedTurnId: ids.b,
          }),
        ],
        { turn: 1 },
      );
      expect(await persistence.loadRewindPlan(id)).toMatchObject({
        turnId: ids.a,
        rewindUsed: true,
      });
    }));

  it('drops scene summaries written by the reverted turn only', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      const memory = new RegistryMemory(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await memory.closeScene(id, 'scene-a', 'Kept scene.', [], ids.a);
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      await memory.closeScene(id, 'scene-b', 'Reverted scene.', [], ids.b);

      await persistence.writeTurn(
        id,
        [
          row('r', 'TurnReverted', {
            type: 'TurnReverted',
            turnId: ids.r,
            revertedTurnId: ids.b,
          }),
        ],
        { turn: 1 },
      );
      const { rows } = await pool.query<{ scene_id: string }>(
        'SELECT scene_id FROM scene_summaries WHERE session_id=$1 ORDER BY scene_id',
        [id],
      );
      expect(rows.map((item) => item.scene_id)).toEqual(['scene-a']);
    }));

  it('retains room-level events logged after the reverted turn began', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(
        id,
        [row('b', 'ToolCall'), row('b', 'NarrationCompleted')],
        { turn: 2 },
      );
      await persistence.append(id, [
        row('pause', 'ActionAccepted', { actionId: 'queued' }),
        row('pause', 'SeatJoined', { accountId: randomUUID() }),
        row('pause', 'SeatRevoked', { accountId: randomUUID() }),
        row('pause', 'PresenceChanged', { accountId: randomUUID() }),
        row('pause', 'TablePaused', { paused: true }),
        row('pause', 'SafetyFlag', { flag: 'x-card' }),
        row('pause', 'ClarificationClosed', { actionId: 'clarification' }),
      ]);

      const plan = await persistence.loadRewindPlan(id);
      expect(plan!.before.events).toEqual([]);
      expect(plan!.retained.map((event) => event.type)).toEqual([
        'ActionAccepted',
        'SeatJoined',
        'SeatRevoked',
        'PresenceChanged',
        'TablePaused',
        'SafetyFlag',
        'ClarificationClosed',
      ]);
      expect(plan!.headSeq).toBe(10);
    }));

  it('refuses a rewind planned against a log head that has since moved', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      const plan = await persistence.loadRewindPlan(id);
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);

      await expect(
        persistence.writeTurn(
          id,
          [
            row('r', 'TurnReverted', {
              type: 'TurnReverted',
              turnId: ids.r,
              revertedTurnId: ids.b,
            }),
          ],
          { turn: 1 },
          undefined,
          [],
          plan!.headSeq,
        ),
      ).rejects.toThrow(LeaseConflictError);
      expect(await persistence.loadRewindPlan(id)).toMatchObject({
        turnId: ids.b,
      });
    }));

  it('hides events of reverted turns from raw log reads', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      await persistence.writeTurn(
        id,
        [
          row('r', 'TurnReverted', {
            type: 'TurnReverted',
            turnId: ids.r,
            revertedTurnId: ids.b,
          }),
        ],
        { turn: 1 },
      );
      const { rows } = await pool.query<{ turn_id: string }>(
        `SELECT turn_id::text AS turn_id FROM events WHERE session_id = $1 AND ${REVERTED_TURN_EXCLUSION} ORDER BY seq`,
        [id],
      );
      expect(rows.map((row) => row.turn_id)).not.toContain(ids.b);
      expect(rows.map((row) => row.turn_id)).toContain(ids.a);
    }));

  it('fences turn writes to the live lease holder', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await pool.query(
        `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
         VALUES ($1,'node-b',now() + interval '1 minute',2)`,
        [id],
      );
      const write = (lease?: { nodeId: string; epoch: number }) =>
        persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {}, lease);

      await expect(write({ nodeId: 'node-a', epoch: 1 })).rejects.toThrow(
        LeaseConflictError,
      );
      await expect(write()).rejects.toThrow(LeaseConflictError);
      await pool.query(
        `UPDATE session_lease SET expires_at = now() - interval '1 second' WHERE session_id = $1`,
        [id],
      );
      await expect(write({ nodeId: 'node-b', epoch: 2 })).rejects.toThrow(
        LeaseConflictError,
      );
      const { rows } = await pool.query(
        'SELECT 1 FROM events WHERE session_id = $1',
        [id],
      );
      expect(rows).toHaveLength(0);
    }));

  it('regenerates a scene summary once its closing turn is rewound', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      const memory = new RegistryMemory(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      await memory.closeScene(id, 'scene-b', 'First telling.', [], ids.b);
      await persistence.writeTurn(id, [revert(ids.b)], { turn: 1 });

      expect(
        await memory.closeScene(
          id,
          'scene-b',
          'Regenerated telling.',
          [],
          ids.c,
        ),
      ).toBe(true);
      const { rows } = await pool.query<{ summary: string }>(
        'SELECT summary FROM scene_summaries WHERE session_id=$1',
        [id],
      );
      expect(rows.map((item) => item.summary)).toEqual([
        'Regenerated telling.',
      ]);
    }));

  it('restores the superseded registry version when the turn that wrote the newer one is rewound', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(
        id,
        [row('a', 'NarrationCompleted')],
        { turn: 1 },
        undefined,
        [npc('Innkeeper')],
        undefined,
        ids.a,
      );
      await persistence.writeTurn(
        id,
        [row('b', 'NarrationCompleted')],
        { turn: 2 },
        undefined,
        [npc('Mayor')],
        undefined,
        ids.b,
      );
      await persistence.writeTurn(id, [revert(ids.b)], { turn: 1 });

      const { rows } = await pool.query<{
        version: number;
        role: string;
        superseded_by: string | null;
      }>(
        `SELECT version, payload->>'role' AS role, superseded_by FROM registry_entries
          WHERE session_id=$1 ORDER BY version`,
        [id],
      );
      expect(rows).toEqual([
        { version: 1, role: 'Innkeeper', superseded_by: null },
      ]);
    }));

  it('keeps derived rows with no recorded source turn when rewinding', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      const memory = new RegistryMemory(pool);
      await persistence.writeTurn(id, [row('a', 'NarrationCompleted')], {
        turn: 1,
      });
      await memory.closeScene(id, 'scene-seed', 'Seeded scene.');
      await memory.upsertMany(id, [
        {
          kind: 'npc',
          id: 'npc_seed',
          after: {
            id: 'npc_seed',
            name: 'Seed Keeper',
            role: 'Guard',
            disposition: 'neutral',
            facts: [],
          },
        },
      ]);
      await persistence.writeTurn(id, [row('b', 'NarrationCompleted')], {
        turn: 2,
      });
      await persistence.writeTurn(id, [revert(ids.b)], { turn: 1 });

      const summaries = await pool.query(
        'SELECT 1 FROM scene_summaries WHERE session_id=$1',
        [id],
      );
      const entries = await pool.query(
        'SELECT 1 FROM registry_entries WHERE session_id=$1',
        [id],
      );
      expect(summaries.rowCount).toBe(1);
      expect(entries.rowCount).toBe(1);
    }));

  it('rolls back the TurnReverted append when derived-row removal fails', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      const memory = new RegistryMemory(pool);
      await persistence.writeTurn(
        id,
        [row('a', 'NarrationCompleted')],
        { turn: 1 },
        undefined,
        [npc('Innkeeper')],
        undefined,
        ids.a,
      );
      await persistence.writeTurn(
        id,
        [row('b', 'NarrationCompleted')],
        { turn: 2 },
        undefined,
        [npc('Mayor')],
        undefined,
        ids.b,
      );
      await memory.closeScene(id, 'scene-b', 'Mayor scene.', [], ids.b);

      await pool.query(
        "CREATE FUNCTION fail_registry_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$",
      );
      await pool.query(
        `CREATE TRIGGER fail_registry_delete BEFORE DELETE ON registry_entries FOR EACH ROW
           WHEN (OLD.session_id = '${id}'::uuid) EXECUTE FUNCTION fail_registry_delete()`,
      );
      try {
        await expect(
          persistence.writeTurn(id, [revert(ids.b)], { turn: 1 }),
        ).rejects.toThrow(/injected delete failure/);
      } finally {
        await pool.query(
          'DROP TRIGGER fail_registry_delete ON registry_entries',
        );
        await pool.query('DROP FUNCTION fail_registry_delete()');
      }

      const reverted = await pool.query(
        'SELECT 1 FROM events WHERE session_id=$1 AND type=$2',
        [id, 'TurnReverted'],
      );
      const summaries = await pool.query<{ summary: string }>(
        'SELECT summary FROM scene_summaries WHERE session_id=$1',
        [id],
      );
      const entries = await pool.query(
        'SELECT 1 FROM registry_entries WHERE session_id=$1',
        [id],
      );
      expect(reverted.rowCount).toBe(0);
      expect(summaries.rows.map((item) => item.summary)).toEqual([
        'Mayor scene.',
      ]);
      expect(entries.rowCount).toBe(2);
    }));

  it('removes registry rows written by a clarification turn inside the rewound window', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(
        id,
        [row('a', 'NarrationCompleted')],
        { turn: 1 },
        undefined,
        [npc('Innkeeper')],
        undefined,
        ids.a,
      );
      await persistence.writeTurn(id, [row('b', 'ToolCall')], { turn: 1 });
      await persistence.writeTurn(
        id,
        [row('c', 'ClarificationRequested')],
        { turn: 1 },
        undefined,
        [npc('Mayor')],
        undefined,
        ids.c,
      );
      await persistence.writeTurn(
        id,
        [row('b', 'NarrationCompleted')],
        { turn: 2 },
        undefined,
        [npc('Guard')],
        undefined,
        ids.b,
      );

      const plan = await persistence.loadRewindPlan(id);
      expect(plan!.turnId).toBe(ids.b);
      expect(plan!.droppedTurnIds).toEqual(
        expect.arrayContaining([ids.b, ids.c]),
      );
      expect(plan!.droppedTurnIds).not.toContain(ids.a);
      await persistence.writeTurn(
        id,
        [revert(ids.b)],
        { turn: 1 },
        undefined,
        [],
        plan!.headSeq,
        undefined,
        plan!.droppedTurnIds,
      );

      const { rows } = await pool.query<{
        version: number;
        role: string;
        superseded_by: string | null;
      }>(
        `SELECT version, payload->>'role' AS role, superseded_by FROM registry_entries
          WHERE session_id=$1 ORDER BY version`,
        [id],
      );
      expect(rows).toEqual([
        { version: 1, role: 'Innkeeper', superseded_by: null },
      ]);
    }));

  it('fails the rewind closed when a surviving registry row supersedes a removed one', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(
        id,
        [row('a', 'NarrationCompleted')],
        { turn: 1 },
        undefined,
        [npc('Innkeeper')],
        undefined,
        ids.a,
      );
      await persistence.writeTurn(
        id,
        [row('b', 'NarrationCompleted')],
        { turn: 2 },
        undefined,
        [npc('Mayor')],
        undefined,
        ids.b,
      );
      await pool.query(
        `UPDATE registry_entries SET version = 3,
            supersedes_id = (SELECT id FROM registry_entries WHERE session_id=$1 AND turn_id=$2)
          WHERE session_id=$1 AND turn_id=$3`,
        [id, ids.b, ids.a],
      );
      const plan = await persistence.loadRewindPlan(id);

      await expect(
        persistence.writeTurn(
          id,
          [revert(ids.b)],
          { turn: 1 },
          undefined,
          [],
          plan!.headSeq,
          undefined,
          plan!.droppedTurnIds,
        ),
      ).rejects.toBeInstanceOf(RewindRefusedError);
      const reverted = await pool.query(
        'SELECT 1 FROM events WHERE session_id=$1 AND type=$2',
        [id, 'TurnReverted'],
      );
      const entries = await pool.query(
        'SELECT 1 FROM registry_entries WHERE session_id=$1',
        [id],
      );
      expect(reverted.rowCount).toBe(0);
      expect(entries.rowCount).toBe(2);
    }));

  it('refuses a rewind when an untagged registry row supersedes a version it would remove', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.writeTurn(
        id,
        [row('a', 'NarrationCompleted')],
        { turn: 1 },
        undefined,
        [npc('Innkeeper')],
        undefined,
        ids.a,
      );
      await persistence.writeTurn(
        id,
        [row('b', 'NarrationCompleted')],
        { turn: 2 },
        undefined,
        [npc('Mayor')],
        undefined,
        ids.b,
      );
      await pool.query(
        `INSERT INTO registry_entries(session_id, entity_type, entity_id, version, name, payload, supersedes_id)
         VALUES ($1, 'npc', 'npc_ada', 3, 'Ada Vale', $2::jsonb,
           (SELECT id FROM registry_entries WHERE session_id=$1 AND turn_id=$3))`,
        [id, JSON.stringify({ role: 'Guard' }), ids.b],
      );
      const plan = await persistence.loadRewindPlan(id);

      await expect(
        persistence.writeTurn(
          id,
          [revert(ids.b)],
          { turn: 1 },
          undefined,
          [],
          plan!.headSeq,
          undefined,
          plan!.droppedTurnIds,
        ),
      ).rejects.toBeInstanceOf(RewindRefusedError);
      const reverted = await pool.query(
        'SELECT 1 FROM events WHERE session_id=$1 AND type=$2',
        [id, 'TurnReverted'],
      );
      const entries = await pool.query(
        'SELECT 1 FROM registry_entries WHERE session_id=$1',
        [id],
      );
      expect(reverted.rowCount).toBe(0);
      expect(entries.rowCount).toBe(3);
    }));

  it('reports no plan when no turn has resolved', () =>
    fixture(async (pool, id) => {
      const persistence = new Persistence(pool);
      await persistence.append(id, [
        row('pause', 'TablePaused', { paused: true }),
      ]);
      expect(await persistence.loadRewindPlan(id)).toBeNull();
    }));
});
