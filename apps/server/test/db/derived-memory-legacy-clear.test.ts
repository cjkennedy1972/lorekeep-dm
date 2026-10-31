import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { runLegacyDerivedMemoryClear } from '../../src/retention/jobs/legacyDerivedMemoryClear.js';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('gated legacy derived-memory clear', () => {
  let db: TestDatabase;
  const sessionIds = Array.from({ length: 4 }, () => randomUUID());
  const characterId = randomUUID();
  const codeVersion = 'test-build-1';

  beforeAll(async () => {
    db = await createTestDatabase({ extraSearchPath: ['public'] });
    await db.pool.query('CREATE TABLE sessions (id uuid PRIMARY KEY)');
    await db.pool.query(
      'CREATE TABLE unrelated_session_data (session_id uuid NOT NULL, value text NOT NULL)',
    );
    await db.pool.query(
      'CREATE TABLE legal_holds (kind text NOT NULL, item_id text NOT NULL, PRIMARY KEY(kind,item_id))',
    );
    await db.pool.query(
      "CREATE TABLE session_seat_characters (session_id uuid NOT NULL, seat_id uuid NOT NULL, character_id uuid NOT NULL, binding_status text NOT NULL DEFAULT 'active')",
    );
    await db.pool.query(
      await readFile(
        new URL('../../migrations/0014_registry.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0030_scene_summary_turn_link.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0031_registry_turn_link.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0045_derived_memory_character_refs.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0048_derived_memory_reconcile_skipped.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0049_derived_memory_legacy_clear_audit.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query('INSERT INTO sessions(id) SELECT unnest($1::uuid[])', [
      sessionIds,
    ]);
    await db.pool.query(
      `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES
      ($1,'legacy','uncovered legacy summary'),($2,'indexed','token-covered summary'),
      ($3,'held','held summary'),($4,'deferred','deferred summary')`,
      sessionIds,
    );
    const indexed = await db.pool.query<{ id: string }>(
      "SELECT id FROM scene_summaries WHERE scene_id='indexed'",
    );
    await db.pool.query(
      'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
      [sessionIds[1], characterId, 'abcdefghijklmnopqrstuvwxyzABCDEF'],
    );
    await db.pool.query(
      'UPDATE scene_summaries SET summary=$2 WHERE scene_id=$1',
      ['indexed', 'summary ref_abcdefghijklmnopqrstuvwxyzABCDEF'],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)",
      [sessionIds[1], characterId, indexed.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)",
      [sessionIds[2]],
    );
    const legacyEntry = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload) VALUES($1,'npc','legacy',1,'legacy registry', '{}') RETURNING id",
      [sessionIds[0]],
    );
    const indexedEntry = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','indexed',1,'token registry', '{\"name\":\"ref_abcdefghijklmnopqrstuvwxyzABCDEF\"}', 'ref_abcdefghijklmnopqrstuvwxyzABCDEF') RETURNING id",
      [sessionIds[1]],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [sessionIds[1], characterId, indexedEntry.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO registry_facts(entry_id,fact) VALUES($1,'legacy fact')",
      [legacyEntry.rows[0]?.id],
    );
    await db.pool.query(
      'INSERT INTO derived_memory_reconcile_skipped(session_id) VALUES($1)',
      [sessionIds[3]],
    );
    await db.pool.query(
      'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
    );
  });
  beforeEach(async () => {
    if (!db) return;
    await db.pool.query('DELETE FROM derived_memory_legacy_clear_audit');
    await db.pool.query('DELETE FROM derived_memory_character_refs');
    await db.pool.query('DELETE FROM session_character_tokens');
    await db.pool.query('DELETE FROM registry_entries');
    await db.pool.query('DELETE FROM scene_summaries');
    await db.pool.query(
      `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,'legacy','uncovered legacy summary'),($2,'indexed','summary ref_abcdefghijklmnopqrstuvwxyzABCDEF'),($3,'held','held summary'),($4,'deferred','deferred summary')`,
      sessionIds,
    );
    const summary = await db.pool.query<{ id: string }>(
      "SELECT id FROM scene_summaries WHERE scene_id='indexed'",
    );
    await db.pool.query(
      'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$2,$3)',
      [sessionIds[1], characterId, 'abcdefghijklmnopqrstuvwxyzABCDEF'],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)",
      [sessionIds[1], characterId, summary.rows[0]?.id],
    );
    await db.pool.query(
      'INSERT INTO session_character_tokens(session_id,character_id,token) VALUES($1,$3,$4),($2,$3,$4)',
      [
        sessionIds[2],
        sessionIds[3],
        characterId,
        'ZYXWVUTSRQPONMLKJIHGFEDCBA654321',
      ],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) SELECT session_id,$1,'scene_summary',id FROM scene_summaries WHERE scene_id IN ('held','deferred')",
      [characterId],
    );
    const legacy = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload) VALUES($1,'npc','legacy',1,'legacy registry', '{}') RETURNING id",
      [sessionIds[0]],
    );
    const indexed = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','indexed',1,'token registry', '{\"name\":\"ref_abcdefghijklmnopqrstuvwxyzABCDEF\"}', 'ref_abcdefghijklmnopqrstuvwxyzABCDEF') RETURNING id",
      [sessionIds[1]],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [sessionIds[1], characterId, indexed.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO registry_facts(entry_id,fact) VALUES($1,'legacy fact')",
      [legacy.rows[0]?.id],
    );
    await db.pool.query(
      'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
    );
  });
  afterAll(async () => db?.close());

  const flags = {
    enabled: true,
    dryRun: true,
    codeVersion,
    batchSize: 1,
    timeBudgetMs: 60_000,
  };

  it('dry-run counts candidates and leaves every row untouched', async () => {
    const result = await runLegacyDerivedMemoryClear(db.pool, {
      enabled: true,
      codeVersion,
      batchSize: 1,
      timeBudgetMs: 60_000,
    });
    expect(result.counts).toEqual({
      sessionsConsidered: 2,
      sessionsSkippedHeld: 1,
      sessionsDeferred: 1,
      sceneSummaries: 1,
      registryEntries: 1,
      registryFacts: 1,
    });
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM scene_summaries'))
        .rows[0]?.n,
    ).toBe(4);
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM registry_entries'))
        .rows[0]?.n,
    ).toBe(2);
    expect(result.outcome).toBe('dry_run_succeeded');
  });

  it('live refuses without a recent successful dry run of the same build', async () => {
    await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      codeVersion: 'other-build',
    });
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/matching successful dry run/i);
  });

  it('live removes only uncovered rows from unheld reconciled sessions, is idempotent, and audits counts only', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const live = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(live.outcome).toBe('live_succeeded');
    expect(live.dryRunId).toBe(dry.runId);
    expect(
      (
        await db.pool.query(
          'SELECT scene_id FROM scene_summaries ORDER BY scene_id',
        )
      ).rows.map((r) => r.scene_id),
    ).toEqual(['deferred', 'held', 'indexed']);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_character_refs WHERE session_id=$1',
          [sessionIds[1]],
        )
      ).rows[0]?.n,
    ).toBe(2);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM registry_facts'))
        .rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id=$1',
          ['held'],
        )
      ).rows[0]?.n,
    ).toBe(1);
    const again = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(again.outcome).toBe('live_succeeded');
    const audits = await db.pool.query<{
      mode: string;
      counts: unknown;
      dry_run_id: string | null;
      approval_reference: string;
    }>(
      'SELECT mode,counts,dry_run_id,approval_reference FROM derived_memory_legacy_clear_audit ORDER BY started_at',
    );
    expect(audits.rows).toHaveLength(3);
    expect(
      audits.rows.every((row) =>
        JSON.stringify(row.counts).includes('sessionsConsidered'),
      ),
    ).toBe(true);
    expect(
      audits.rows.every((row) =>
        row.approval_reference.includes('Gmail INBOX uid 58'),
      ),
    ).toBe(true);
    expect(JSON.stringify(audits.rows)).not.toMatch(
      /uncovered legacy summary|held summary|indexed summary|deferred summary/,
    );
  });

  it('aborts before deletion when live counts drift from the dry run', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'after-dry-run','new legacy')",
      [sessionIds[0]],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/matching successful dry run/i);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM scene_summaries WHERE session_id=$1',
          [sessionIds[0]],
        )
      ).rows[0]?.n,
    ).toBe(2);
    expect(
      (
        await db.pool.query(
          "SELECT outcome FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows[0]?.outcome,
    ).toBe('aborted');
  });

  it('resumes a bounded partial run using the same dry-run plan and audit row', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    let calls = 0;
    const partial = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
      batchSize: 1,
      timeBudgetMs: 1,
      now: () => new Date(Date.now() + (calls++ === 0 ? 0 : 10_000)),
    });
    expect(partial.outcome).toBe('live_partial');
    expect(partial.dryRunId).toBe(dry.runId);
    const resumed = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(resumed.runId).toBe(partial.runId);
    expect(resumed.outcome).toBe('live_succeeded');
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_audit',
        )
      ).rows[0]?.n,
    ).toBe(2);
  });

  it('flags are off by default', async () => {
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { codeVersion }),
    ).rejects.toThrow(/disabled/i);
  });
});
