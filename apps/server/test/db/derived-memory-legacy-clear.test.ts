import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { runLegacyDerivedMemoryClear } from '../../src/retention/jobs/legacyDerivedMemoryClear.js';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('gated legacy derived-memory clear', () => {
  let db: TestDatabase;
  const sessionIds = Array.from({ length: 6 }, () => randomUUID());
  const accountIds = Array.from({ length: 6 }, () => randomUUID());
  const exportId = randomUUID();
  const unheldExportId = randomUUID();
  const characterId = randomUUID();
  const codeVersion = 'test-build-1';

  beforeAll(async () => {
    db = await createTestDatabase({ extraSearchPath: ['public'] });
    await db.pool.query(
      'CREATE TABLE sessions (id uuid PRIMARY KEY, owner_account_id uuid NOT NULL)',
    );
    await db.pool.query(
      'CREATE TABLE export_jobs (id uuid PRIMARY KEY, account_id uuid NOT NULL)',
    );
    await db.pool.query(
      'CREATE TABLE unrelated_session_data (session_id uuid NOT NULL, value text NOT NULL)',
    );
    await db.pool.query(
      'CREATE TABLE legal_holds (kind text NOT NULL, item_id text NOT NULL, PRIMARY KEY(kind,item_id))',
    );
    await db.pool.query(
      "CREATE TABLE session_seat_characters (session_id uuid NOT NULL, seat_id uuid NOT NULL, account_id uuid, character_id uuid NOT NULL, binding_status text NOT NULL DEFAULT 'active')",
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
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0046_derived_memory_hold_serialization.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0050_derived_memory_account_hold_serialization.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      'INSERT INTO sessions(id,owner_account_id) SELECT * FROM unnest($1::uuid[],$2::uuid[])',
      [sessionIds, accountIds],
    );
    await db.pool.query(
      'INSERT INTO export_jobs(id,account_id) VALUES($1,$2),($3,$4)',
      [exportId, accountIds[4], unheldExportId, accountIds[0]],
    );
    await db.pool.query(
      `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES
      ($1,'legacy','uncovered legacy summary'),($2,'indexed','token-covered summary'),
      ($3,'held','held summary'),($4,'account-held','account-held summary'),
      ($5,'export-held','export-held summary'),($6,'deferred','deferred summary')`,
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
      "INSERT INTO legal_holds(kind,item_id) VALUES ('session',$1),('account',$2),('export',$3)",
      [sessionIds[2], accountIds[3], exportId],
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
      [sessionIds[5]],
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
      `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,'legacy','uncovered legacy summary'),($2,'indexed','summary ref_abcdefghijklmnopqrstuvwxyzABCDEF'),($3,'held','held summary'),($4,'account-held','account-held summary'),($5,'export-held','export-held summary'),($6,'deferred','deferred summary')`,
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
      sessionsSkippedHeld: 3,
      sessionsDeferred: 1,
      sceneSummaries: 1,
      registryEntries: 1,
      registryFacts: 1,
    });
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM scene_summaries'))
        .rows[0]?.n,
    ).toBe(6);
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

  it('preserves covered registry and scene rows alongside uncovered legacy rows in the same session', async () => {
    const coveredSummary = await db.pool.query<{ id: string }>(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'covered-same-session','covered summary') RETURNING id",
      [sessionIds[0]],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'scene_summary',$3)",
      [sessionIds[0], characterId, coveredSummary.rows[0]?.id],
    );
    const coveredEntry = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','covered-same-session',1,'covered registry','{}','covered searchable text') RETURNING id",
      [sessionIds[0]],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [sessionIds[0], characterId, coveredEntry.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO registry_facts(entry_id,fact) VALUES($1,'covered fact')",
      [coveredEntry.rows[0]?.id],
    );

    await runLegacyDerivedMemoryClear(db.pool, flags);
    await runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false });

    expect(
      (
        await db.pool.query(
          'SELECT scene_id FROM scene_summaries WHERE session_id=$1 ORDER BY scene_id',
          [sessionIds[0]],
        )
      ).rows.map((row) => row.scene_id),
    ).toEqual(['covered-same-session']);
    const entry = await db.pool.query<{
      entity_id: string;
      search_document: string;
      search_vector: string;
    }>(
      'SELECT entity_id,search_document,search_vector::text FROM registry_entries WHERE id=$1',
      [coveredEntry.rows[0]?.id],
    );
    expect(entry.rows).toEqual([
      expect.objectContaining({
        entity_id: 'covered-same-session',
        search_document: 'covered searchable text',
        search_vector: expect.stringContaining("'cover':1"),
      }),
    ]);
    expect(
      (
        await db.pool.query(
          'SELECT fact FROM registry_facts WHERE entry_id=$1',
          [coveredEntry.rows[0]?.id],
        )
      ).rows,
    ).toEqual([{ fact: 'covered fact' }]);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('refuses live execution when global reconciliation is incomplete', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      'UPDATE derived_memory_reconciliation_state SET complete=false WHERE singleton=true',
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/reconciliation to be complete/i);
    expect(
      (
        await db.pool.query(
          "SELECT outcome FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows,
    ).toEqual([{ outcome: 'aborted' }]);
  });

  it('defers sessions with registry supersession chains across the coverage boundary', async () => {
    const legacyPredecessor = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload) VALUES($1,'npc','legacy-before-index',1,'legacy predecessor','{}') RETURNING id",
      [sessionIds[0]],
    );
    const indexedSuccessor = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,supersedes_id) VALUES($1,'npc','legacy-before-index',2,'indexed successor','{}',$2) RETURNING id",
      [sessionIds[0], legacyPredecessor.rows[0]?.id],
    );
    await db.pool.query(
      'UPDATE registry_entries SET superseded_by=$2 WHERE id=$1',
      [legacyPredecessor.rows[0]?.id, indexedSuccessor.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [sessionIds[0], characterId, indexedSuccessor.rows[0]?.id],
    );
    const indexedPredecessor = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload) VALUES($1,'npc','index-before-legacy',1,'indexed predecessor','{}') RETURNING id",
      [sessionIds[0]],
    );
    const legacySuccessor = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,supersedes_id) VALUES($1,'npc','index-before-legacy',2,'legacy successor','{}',$2) RETURNING id",
      [sessionIds[0], indexedPredecessor.rows[0]?.id],
    );
    await db.pool.query(
      'UPDATE registry_entries SET superseded_by=$2 WHERE id=$1',
      [indexedPredecessor.rows[0]?.id, legacySuccessor.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO derived_memory_character_refs(session_id,character_id,row_kind,row_id) VALUES($1,$2,'registry_entry',$3)",
      [sessionIds[0], characterId, indexedPredecessor.rows[0]?.id],
    );

    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(dry.counts.sessionsDeferred).toBe(2);
    expect(dry.counts.registryEntries).toBe(0);
    await runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false });
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM registry_entries WHERE session_id=$1',
          [sessionIds[0]],
        )
      ).rows[0]?.n,
    ).toBe(5);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('requires a fresh dry run after recovering an orphaned live audit', async () => {
    const originalDryRun = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    await db.pool.query(
      "INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at) VALUES($1,'live',$2,$3,$4::jsonb,'running',now())",
      [
        runId,
        codeVersion,
        originalDryRun.runId,
        JSON.stringify({
          ...originalDryRun.counts,
          sessionsProcessed: 0,
          sceneSummariesRemoved: 0,
          registryEntriesRemoved: 0,
          registryFactsRemoved: 0,
        }),
      ],
    );
    await db.pool.query("DELETE FROM scene_summaries WHERE scene_id='legacy'");
    await db.pool.query(
      "DELETE FROM registry_entries WHERE entity_id='legacy'",
    );
    await runLegacyDerivedMemoryClear(db.pool, flags);
    const resumed = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(resumed.outcome).toBe('live_succeeded');
    expect(
      (
        await db.pool.query(
          'SELECT outcome FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0]?.outcome,
    ).toBe('failed');
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
    ).toEqual(['account-held', 'deferred', 'export-held', 'held', 'indexed']);
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

  it('bounds waits for concurrent session writers with lock_timeout', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    const writer = await db.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'writer-lock','uncommitted')",
        [sessionIds[0]],
      );
      await expect(
        runLegacyDerivedMemoryClear(db.pool, {
          ...flags,
          dryRun: false,
          sessionLockTimeoutMs: 25,
        }),
      ).rejects.toThrow(/lock timeout/i);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it.each([
    ['account', accountIds[0]],
    ['export', unheldExportId],
  ])(
    'serializes %s hold changes against affected session locks',
    async (kind, itemId) => {
      const sessionLocker = await db.pool.connect();
      const holdWriter = await db.pool.connect();
      try {
        await sessionLocker.query('BEGIN');
        await sessionLocker.query(
          'SELECT id FROM sessions WHERE id=$1 FOR UPDATE',
          [sessionIds[0]],
        );
        await holdWriter.query('BEGIN');
        await holdWriter.query("SELECT set_config('lock_timeout','25ms',true)");
        await expect(
          holdWriter.query(
            'INSERT INTO legal_holds(kind,item_id) VALUES($1,$2)',
            [kind, itemId],
          ),
        ).rejects.toThrow(/lock timeout/i);
      } finally {
        await holdWriter.query('ROLLBACK');
        await sessionLocker.query('ROLLBACK');
        holdWriter.release();
        sessionLocker.release();
      }
    },
  );

  it('flags are off by default', async () => {
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { codeVersion }),
    ).rejects.toThrow(/disabled/i);
  });
});
