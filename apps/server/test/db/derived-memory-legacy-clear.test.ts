import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import {
  runLegacyDerivedMemoryClear,
  type LegacyClearCounts,
} from '../../src/retention/jobs/legacyDerivedMemoryClear.js';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('gated legacy derived-memory clear', () => {
  let db: TestDatabase;
  const sessionIds = Array.from({ length: 7 }, () => randomUUID());
  const accountIds = Array.from({ length: 7 }, () => randomUUID());
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
      await readFile(
        new URL(
          '../../migrations/0051_derived_memory_legacy_clear_recovery.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0052_derived_memory_legacy_clear_backup_attestation.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.pool.query(
      await readFile(
        new URL(
          '../../migrations/0053_derived_memory_legacy_clear_plan.sql',
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
      sessionIds.slice(0, 6),
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
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','legacy',1,'legacy registry', '{}','legacy searchable document') RETURNING id",
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
      'UPDATE derived_memory_reconciliation_state SET complete=true WHERE singleton=true',
    );
  });
  beforeEach(async () => {
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT =
      new Date().toISOString();
    if (!db) return;
    await db.pool.query('DELETE FROM session_seat_characters');
    await db.pool.query('DELETE FROM derived_memory_reconcile_skipped');
    await db.pool.query('DELETE FROM derived_memory_legacy_clear_audit');
    await db.pool.query('DELETE FROM derived_memory_character_refs');
    await db.pool.query('DELETE FROM session_character_tokens');
    await db.pool.query('DELETE FROM registry_entries');
    await db.pool.query('DELETE FROM scene_summaries');
    await db.pool.query('DELETE FROM unrelated_session_data');
    await db.pool.query(
      'INSERT INTO unrelated_session_data(session_id,value) VALUES($1,$2)',
      [sessionIds[0], 'unrelated survives'],
    );
    await db.pool.query(
      `INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES ($1,'legacy','uncovered legacy summary'),($2,'indexed','summary ref_abcdefghijklmnopqrstuvwxyzABCDEF'),($3,'held','held summary'),($4,'account-held','account-held summary'),($5,'export-held','export-held summary'),($6,'deferred','deferred summary')`,
      sessionIds.slice(0, 6),
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
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,search_document) VALUES($1,'npc','legacy',1,'legacy registry', '{}','legacy searchable document') RETURNING id",
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
      sessionsConsidered: 3,
      sessionsSkippedHeld: 3,
      sessionsDeferred: 0,
      sessionsDeferredChain: 0,
      sceneSummaries: 2,
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
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [result.runId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
  });

  it('refuses live without a valid recent backup attestation and purges its plan', async () => {
    for (const value of [
      undefined,
      'not-an-iso-date',
      new Date(Date.now() - 24 * 60 * 60_000 - 1).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    ]) {
      const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
      if (value === undefined)
        delete process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT;
      else process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT = value;
      await expect(
        runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
      ).rejects.toThrow(/backup attestation/i);
      const aborted = await db.pool.query<{
        outcome: string;
        reason_code: string;
        backup_confirmed_at: Date | null;
      }>(
        "SELECT outcome,reason_code,backup_confirmed_at FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
      );
      expect(aborted.rows[0]).toEqual({
        outcome: 'aborted',
        reason_code: 'backup_not_confirmed',
        backup_confirmed_at: null,
      });
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
            [dry.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan_runs WHERE dry_run_id=$1',
            [dry.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }
  });

  it('live refuses without a recent successful dry run of the same build', async () => {
    await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      codeVersion: 'other-build',
    });
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/recent matching successful dry run/i);
  });

  it('refuses live execution when no dry run exists', async () => {
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/matching successful dry run/i);
    expect(
      (
        await db.pool.query(
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows,
    ).toEqual([{ outcome: 'aborted', reason_code: 'dry_run_count_mismatch' }]);
  });

  it('refuses a successful dry run outside the configured freshness window', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "UPDATE derived_memory_legacy_clear_audit SET finished_at=now()-interval '2 hours' WHERE run_id=$1",
      [dry.runId],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, {
        ...flags,
        dryRun: false,
        dryRunMaxAgeMs: 60_000,
      }),
    ).rejects.toThrow(/matching successful dry run/i);
    expect(
      (
        await db.pool.query(
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows,
    ).toEqual([{ outcome: 'aborted', reason_code: 'dry_run_count_mismatch' }]);
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
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy' AND search_document='legacy searchable document'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM registry_facts'))
        .rows[0]?.n,
    ).toBe(1);
    expect(
      (await db.pool.query('SELECT value FROM unrelated_session_data')).rows,
    ).toEqual([{ value: 'unrelated survives' }]);
  });

  it('refuses live execution when global reconciliation is incomplete and purges the plan', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      'UPDATE derived_memory_reconciliation_state SET complete=false WHERE singleton=true',
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/reconciliation to be complete/i);
    expect(
      (
        await db.pool.query(
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows,
    ).toEqual([
      { outcome: 'aborted', reason_code: 'global_reconciliation_incomplete' },
    ]);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('defers coverage-skipped sessions while completing other reconciled sessions', async () => {
    await db.pool.query(
      'INSERT INTO derived_memory_reconcile_skipped(session_id) VALUES($1)',
      [sessionIds[0]],
    );
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(dry.counts.sessionsDeferred).toBe(1);
    const live = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(live.outcome).toBe('live_succeeded');
    expect(live.counts.sessionsDeferred).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT scene_id FROM scene_summaries WHERE scene_id IN ('legacy','deferred') ORDER BY scene_id",
        )
      ).rows.map((row) => row.scene_id),
    ).toEqual(['legacy']);
  });

  it('defers every session containing any supersession link as a whole', async () => {
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
    const legacyRoot = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload) VALUES($1,'npc','legacy-only-chain',1,'legacy chain root','{}') RETURNING id",
      [sessionIds[6]],
    );
    const legacyChild = await db.pool.query<{ id: string }>(
      "INSERT INTO registry_entries(session_id,entity_type,entity_id,version,name,payload,supersedes_id) VALUES($1,'npc','legacy-only-chain',2,'legacy chain child','{}',$2) RETURNING id",
      [sessionIds[6], legacyRoot.rows[0]?.id],
    );
    await db.pool.query(
      'UPDATE registry_entries SET superseded_by=$2 WHERE id=$1',
      [legacyRoot.rows[0]?.id, legacyChild.rows[0]?.id],
    );
    await db.pool.query(
      "INSERT INTO registry_facts(entry_id,fact) VALUES($1,'legacy root fact'),($2,'legacy child fact')",
      [legacyRoot.rows[0]?.id, legacyChild.rows[0]?.id],
    );

    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(dry.counts.sessionsDeferred).toBe(2);
    expect(dry.counts.sessionsDeferredChain).toBe(2);
    expect(dry.counts.registryEntries).toBe(0);
    const live = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(live.counts.registryEntries).toBe(dry.counts.registryEntries);
    expect(live.counts.registryFacts).toBe(dry.counts.registryFacts);
    expect(live.counts.sessionsDeferredChain).toBe(2);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM registry_entries WHERE id=ANY($1::bigint[])',
          [
            [
              legacyPredecessor.rows[0]?.id,
              indexedSuccessor.rows[0]?.id,
              indexedPredecessor.rows[0]?.id,
              legacySuccessor.rows[0]?.id,
            ],
          ],
        )
      ).rows[0]?.n,
    ).toBe(4);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM registry_entries WHERE id=ANY($1::bigint[])',
          [[legacyRoot.rows[0]?.id, legacyChild.rows[0]?.id]],
        )
      ).rows[0]?.n,
    ).toBe(2);
  });

  it('treats a hold on an associated seat account as a session hold', async () => {
    await db.pool.query(
      'INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id) VALUES($1,$2,$3,$4)',
      [sessionIds[6], randomUUID(), accountIds[6], characterId],
    );
    await db.pool.query(
      "INSERT INTO legal_holds(kind,item_id) VALUES('account',$1)",
      [accountIds[6]],
    );
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'seat-account-held','held')",
      [sessionIds[6]],
    );
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(dry.counts.sessionsSkippedHeld).toBe(4);
    await runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false });
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='seat-account-held'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    await db.pool.query(
      "DELETE FROM legal_holds WHERE kind='account' AND item_id=$1",
      [accountIds[6]],
    );
  });

  it('does not mark a running audit stale unless it owns the advisory lock', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    await db.pool.query(
      "INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,heartbeat_at) VALUES($1,'live',$2,$3,'{}'::jsonb,'running',now(),now()-interval '20 minutes')",
      [runId, codeVersion, dry.runId],
    );
    const lockHolder = await db.pool.connect();
    try {
      await lockHolder.query('SELECT pg_advisory_lock($1)', [7_201_939]);
      await expect(runLegacyDerivedMemoryClear(db.pool, flags)).rejects.toThrow(
        /advisory lock/i,
      );
      expect(
        (
          await db.pool.query(
            'SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
            [runId],
          )
        ).rows[0],
      ).toEqual({ outcome: 'running', reason_code: null });
    } finally {
      await lockHolder.query('SELECT pg_advisory_unlock($1)', [7_201_939]);
      lockHolder.release();
    }
  });

  it('marks stale running audits failed with process_died before starting a fresh run', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    await db.pool.query(
      "INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,heartbeat_at) VALUES($1,'live',$2,$3,'{}'::jsonb,'running',now(),now()-interval '20 minutes')",
      [runId, codeVersion, dry.runId],
    );
    await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(
      (
        await db.pool.query(
          'SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0],
    ).toEqual({ outcome: 'failed', reason_code: 'superseded_by_new_dry_run' });
  });

  it('marks stale running audits failed and preserves their last persisted counts', async () => {
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
    await db.pool.query(
      "UPDATE derived_memory_legacy_clear_audit SET heartbeat_at=now()-interval '20 minutes' WHERE run_id=$1",
      [runId],
    );
    await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      runningStaleAfterMs: 1,
    });
    expect(
      (
        await db.pool.query(
          'SELECT outcome,reason_code,counts FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0],
    ).toMatchObject({
      outcome: 'failed',
      reason_code: 'superseded_by_new_dry_run',
      counts: {
        ...originalDryRun.counts,
        sessionsProcessed: 0,
        sceneSummariesRemoved: 0,
        registryEntriesRemoved: 0,
        registryFactsRemoved: 0,
      },
    });
    expect(
      (
        await db.pool.query(
          'SELECT outcome,reason_code,counts FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0],
    ).toMatchObject({
      outcome: 'failed',
      reason_code: 'superseded_by_new_dry_run',
      counts: {
        ...originalDryRun.counts,
        sessionsProcessed: 0,
        sceneSummariesRemoved: 0,
        registryEntriesRemoved: 0,
        registryFactsRemoved: 0,
      },
    });
  });

  it('successful same-plan resume clears the stale process_died reason', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    const counts = {
      ...dry.counts,
      sessionsProcessed: 0,
      sceneSummariesRemoved: 0,
      registryEntriesRemoved: 0,
      registryFactsRemoved: 0,
    };
    await db.pool.query(
      `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,reason_code,started_at,finished_at,heartbeat_at)
       VALUES($1,'live',$2,$3,$4::jsonb,'failed','process_died',now(),now(),now()-interval '20 minutes')`,
      [runId, codeVersion, dry.runId, JSON.stringify(counts)],
    );
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
    const resumed = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(resumed.runId).toBe(runId);
    expect(resumed.outcome).toBe('live_succeeded');
    const finalAudit = await db.pool.query<{
      outcome: string;
      reason_code: string | null;
    }>(
      'SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
      [runId],
    );
    expect(finalAudit.rows[0]).toEqual({
      outcome: 'live_succeeded',
      reason_code: null,
    });
  });

  it('resumes a SIGKILLed child runner from its persisted batch counts', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const beforeCounts = await db.pool.query<{
      summaries: number;
      entries: number;
      facts: number;
    }>(
      'SELECT (SELECT count(*)::int FROM scene_summaries) summaries, (SELECT count(*)::int FROM registry_entries) entries, (SELECT count(*)::int FROM registry_facts) facts',
    );
    await db.pool.query(
      "UPDATE scene_summaries SET summary=summary WHERE scene_id='legacy'",
    );
    execFileSync('pnpm', ['--filter', '@game/server', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    const moduleUrl = new URL(
      '../../dist/retention/jobs/legacyDerivedMemoryClear.js',
      import.meta.url,
    ).href;
    const code = `import { Pool } from 'pg'; import { runLegacyDerivedMemoryClear } from ${JSON.stringify(moduleUrl)}; const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path=${db.schema},public'}); await runLegacyDerivedMemoryClear(pool,{enabled:true,dryRun:false,codeVersion:${JSON.stringify(codeVersion)},batchSize:1,timeBudgetMs:60000,log:(event,counts,outcome)=>console.log(JSON.stringify({event,counts,outcome}))}); await pool.end();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let killed = false;
    const childExit = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error('child did not commit a deletion batch before timeout'),
        );
      }, 20_000);
      child.stdout.on('data', async (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (!line.includes('legacy_clear_live_batch_committed')) continue;
          try {
            const event = JSON.parse(line) as { counts: LegacyClearCounts };
            if (
              !killed &&
              (event.counts.sceneSummaries > 0 ||
                event.counts.registryEntries > 0)
            ) {
              killed = true;
              child.kill('SIGKILL');
            }
          } catch {
            /* wait for a complete structured line */
          }
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (_code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL' && killed) resolve();
        else
          reject(
            new Error(
              `child exited unexpectedly (${signal ?? 'no signal'}): ${output}`,
            ),
          );
      });
    });
    await childExit;
    const running = await db.pool.query<{
      outcome: string;
      counts: Record<string, number>;
    }>(
      "SELECT outcome,counts FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
    );
    expect(running.rows[0]?.outcome).toBe('running');
    expect(
      (running.rows[0]?.counts.sceneSummariesRemoved ?? 0) +
        (running.rows[0]?.counts.registryEntriesRemoved ?? 0),
    ).toBeGreaterThan(0);
    const afterKill = await db.pool.query<{
      summaries: number;
      entries: number;
      facts: number;
    }>(
      'SELECT (SELECT count(*)::int FROM scene_summaries) summaries, (SELECT count(*)::int FROM registry_entries) entries, (SELECT count(*)::int FROM registry_facts) facts',
    );
    expect(running.rows[0]?.counts.sceneSummariesRemoved).toBe(
      beforeCounts.rows[0]!.summaries - afterKill.rows[0]!.summaries,
    );
    expect(running.rows[0]?.counts.registryEntriesRemoved).toBe(
      beforeCounts.rows[0]!.entries - afterKill.rows[0]!.entries,
    );
    expect(running.rows[0]?.counts.registryFactsRemoved).toBe(
      beforeCounts.rows[0]!.facts - afterKill.rows[0]!.facts,
    );
    await db.pool.query(
      "UPDATE derived_memory_legacy_clear_audit SET heartbeat_at=now()-interval '20 minutes' WHERE mode='live' AND outcome='running'",
    );
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
    const freshDry = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    const failed = await db.pool.query<{
      outcome: string;
      reason_code: string;
      counts: Record<string, number>;
    }>(
      "SELECT outcome,reason_code,counts FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
    );
    expect(failed.rows[0]?.outcome).toBe('failed');
    expect(failed.rows[0]?.reason_code).toBe('superseded_by_new_dry_run');
    expect(failed.rows[0]?.counts.sceneSummariesRemoved).toBe(
      beforeCounts.rows[0]!.summaries - afterKill.rows[0]!.summaries,
    );
    expect(failed.rows[0]?.counts.registryEntriesRemoved).toBe(
      beforeCounts.rows[0]!.entries - afterKill.rows[0]!.entries,
    );
    expect(failed.rows[0]?.counts.registryFactsRemoved).toBe(
      beforeCounts.rows[0]!.facts - afterKill.rows[0]!.facts,
    );
    const resumed = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
      runningStaleAfterMs: 1,
    });
    expect(resumed.outcome).toBe('live_succeeded');
    expect(resumed.dryRunId).toBe(freshDry.runId);
    expect(resumed.dryRunId).not.toBe(dry.runId);
    const superseded = await db.pool.query<{
      reason_code: string;
      counts: Record<string, number>;
    }>(
      "SELECT reason_code,counts FROM derived_memory_legacy_clear_audit WHERE mode='live' AND dry_run_id=$1",
      [dry.runId],
    );
    expect(superseded.rows[0]?.reason_code).toBe('superseded_by_new_dry_run');
    expect(superseded.rows[0]?.counts.sceneSummariesRemoved).toBeGreaterThan(0);
  });

  it('does not resume a failed live audit without reason_code process_died', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const counts = {
      ...dry.counts,
      sessionsProcessed: 0,
      sceneSummariesRemoved: 0,
      registryEntriesRemoved: 0,
      registryFactsRemoved: 0,
    };
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,reason_code,started_at,finished_at,heartbeat_at)
       VALUES($1,'live',$2,$3,$4::jsonb,'failed',NULL,now(),now(),now())`,
      [runId, codeVersion, dry.runId, JSON.stringify(counts)],
    );
    const fresh = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(fresh.outcome).toBe('live_succeeded');
    expect(fresh.runId).not.toBe(runId);
    expect(fresh.dryRunId).toBe(dry.runId);
  });

  it('fresh dry run supersedes a process_died resume target without losing its counts', async () => {
    const originalDry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    const persistedCounts = {
      ...originalDry.counts,
      sessionsProcessed: 1,
      sceneSummariesRemoved: 1,
      registryEntriesRemoved: 0,
      registryFactsRemoved: 0,
    };
    await db.pool.query(
      `INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,reason_code,started_at,finished_at,heartbeat_at)
       VALUES($1,'live',$2,$3,$4::jsonb,'failed','process_died',now()-interval '1 minute',now(),now()-interval '20 minutes')`,
      [runId, codeVersion, originalDry.runId, JSON.stringify(persistedCounts)],
    );
    const freshDry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const freshLive = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(freshLive.outcome).toBe('live_succeeded');
    expect(freshLive.dryRunId).toBe(freshDry.runId);
    const prior = await db.pool.query<{
      outcome: string;
      reason_code: string;
      counts: Record<string, number>;
    }>(
      'SELECT outcome,reason_code,counts FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
      [runId],
    );
    expect(prior.rows[0]).toMatchObject({
      outcome: 'failed',
      reason_code: 'superseded_by_new_dry_run',
      counts: persistedCounts,
    });
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [originalDry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [freshDry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('rolls back the current session batch and purges the plan after a thrown failure', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      `CREATE FUNCTION fail_legacy_clear_summary_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback'; END $$`,
    );
    await db.pool.query(
      'CREATE TRIGGER fail_legacy_clear_summary_delete BEFORE DELETE ON scene_summaries FOR EACH ROW EXECUTE FUNCTION fail_legacy_clear_summary_delete()',
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/injected rollback/);
    for (const table of [
      'derived_memory_legacy_clear_plan_runs',
      'derived_memory_legacy_clear_plan',
    ]) {
      expect(
        (
          await db.pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE dry_run_id=$1`,
            [dry.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    await db.pool.query(
      'DROP TRIGGER fail_legacy_clear_summary_delete ON scene_summaries',
    );
    await db.pool.query('DROP FUNCTION fail_legacy_clear_summary_delete()');
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_missing_run_dry_run_again.*fresh dry run/i);
    expect(
      (
        await db.pool.query(
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
        )
      ).rows[0],
    ).toEqual({
      outcome: 'aborted',
      reason_code: 'plan_missing_run_dry_run_again',
    });
  });

  it('refuses resume when candidate counts increase beyond the original plan', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'increase-after-dry-run','extra')",
      [sessionIds[0]],
    );
    const runId = randomUUID();
    await db.pool.query(
      "INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,heartbeat_at) VALUES($1,'live',$2,$3,$4::jsonb,'live_partial',now(),now())",
      [
        runId,
        codeVersion,
        dry.runId,
        JSON.stringify({
          ...dry.counts,
          sessionsProcessed: 0,
          sceneSummariesRemoved: 0,
          registryEntriesRemoved: 0,
          registryFactsRemoved: 0,
        }),
      ],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    expect(
      (
        await db.pool.query(
          'SELECT outcome FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0]?.outcome,
    ).toBe('live_partial');
  });

  it('refuses resume when candidate counts decrease outside committed work', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const runId = randomUUID();
    await db.pool.query(
      "INSERT INTO derived_memory_legacy_clear_audit(run_id,mode,code_version,dry_run_id,counts,outcome,started_at,heartbeat_at) VALUES($1,'live',$2,$3,$4::jsonb,'live_partial',now(),now())",
      [
        runId,
        codeVersion,
        dry.runId,
        JSON.stringify({
          ...dry.counts,
          sessionsProcessed: 0,
          sceneSummariesRemoved: 0,
          registryEntriesRemoved: 0,
          registryFactsRemoved: 0,
        }),
      ],
    );
    await db.pool.query("DELETE FROM scene_summaries WHERE scene_id='legacy'");
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          'SELECT outcome FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [runId],
        )
      ).rows[0]?.outcome,
    ).toBe('live_partial');
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
    ).toEqual(['account-held', 'export-held', 'held', 'indexed']);
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
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_missing_run_dry_run_again/i);
    const audits = await db.pool.query<{
      mode: string;
      counts: unknown;
      dry_run_id: string | null;
      approval_reference: string;
      backup_confirmed_at: Date | null;
    }>(
      'SELECT mode,counts,dry_run_id,approval_reference,backup_confirmed_at FROM derived_memory_legacy_clear_audit ORDER BY started_at',
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
    expect(
      audits.rows
        .filter((row) => row.mode === 'live')
        .every((row) => row.backup_confirmed_at instanceof Date),
    ).toBe(true);
    expect(JSON.stringify(audits.rows)).not.toMatch(
      /uncovered legacy summary|held summary|indexed summary|deferred summary/,
    );
  });

  it('refuses a same-count row swap because live must execute the approved row identities', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const planned = await db.pool.query<{ id: string }>(
      "SELECT id::text FROM scene_summaries WHERE session_id=$1 AND scene_id='legacy'",
      [sessionIds[0]],
    );
    await db.pool.query('DELETE FROM scene_summaries WHERE id=$1', [
      planned.rows[0]!.id,
    ]);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'replacement','new uncovered summary')",
      [sessionIds[0]],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM scene_summaries WHERE session_id=$1',
          [sessionIds[0]],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
        )
      ).rows[0],
    ).toEqual({ outcome: 'aborted', reason_code: 'plan_digest_mismatch' });
    expect(dry.counts.sceneSummaries).toBeGreaterThan(0);
  });

  it('refuses a candidate added after dry run before deleting any planned row', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'new-after-plan','new text')",
      [sessionIds[0]],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
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
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(dry.outcome).toBe('dry_run_succeeded');
  });

  it('refuses a planned row removed after dry run before deleting anything else', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "DELETE FROM scene_summaries WHERE session_id=$1 AND scene_id='legacy'",
      [sessionIds[0]],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM registry_entries WHERE entity_id='legacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('deletes only planned IDs when candidates change after the locked identity check', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const planned = await db.pool.query<{ id: string }>(
      "SELECT id::text FROM scene_summaries WHERE session_id=$1 AND scene_id='legacy'",
      [sessionIds[0]],
    );
    const plannedId = planned.rows[0]!.id;
    await expect(
      runLegacyDerivedMemoryClear(db.pool, {
        ...flags,
        dryRun: false,
        afterSessionIdentityCheckForTests: async (client, sessionId) => {
          if (sessionId !== sessionIds[0]) return;
          await client.query('DELETE FROM scene_summaries WHERE id=$1', [
            plannedId,
          ]);
          await client.query(
            "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'post-check-replacement','unplanned')",
            [sessionId],
          );
        },
      }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    expect(
      (
        await db.pool.query(
          'SELECT id::text FROM scene_summaries WHERE id=$1',
          [plannedId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='post-check-replacement'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(dry.outcome).toBe('dry_run_succeeded');
  });

  it('rechecks the next session after an earlier session commits and preserves counts on drift', async () => {
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'mid-run-original','planned before live')",
      [sessionIds[1]],
    );
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    let seen = 0;
    await expect(
      runLegacyDerivedMemoryClear(db.pool, {
        ...flags,
        dryRun: false,
        beforeSessionLockForTests: async (sessionId) => {
          if (seen++ !== 1) return;
          await db.pool.query(
            "DELETE FROM scene_summaries WHERE session_id=$1 AND scene_id='mid-run-original'",
            [sessionId],
          );
          await db.pool.query(
            "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'mid-run-replacement','replacement')",
            [sessionId],
          );
        },
      }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
    const audit = await db.pool.query<{
      outcome: string;
      reason_code: string;
      counts: Record<string, number>;
    }>(
      "SELECT outcome,reason_code,counts FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
    );
    expect(audit.rows[0]?.outcome).toBe('failed');
    expect(audit.rows[0]?.reason_code).toBe('plan_digest_mismatch');
    expect(audit.rows[0]?.counts.sceneSummariesRemoved).toBeGreaterThan(0);
    expect(dry.counts.sceneSummaries).toBeGreaterThan(
      audit.rows[0]!.counts.sceneSummariesRemoved,
    );
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM scene_summaries WHERE scene_id='mid-run-replacement'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('purges the old plan when a same-version dry run is repeated', async () => {
    const first = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      'DELETE FROM derived_memory_legacy_clear_plan_runs WHERE dry_run_id=$1',
      [first.runId],
    );
    const second = await runLegacyDerivedMemoryClear(db.pool, flags);
    expect(second.runId).not.toBe(first.runId);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [first.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [second.runId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
  });

  it('purges plan rows after the approved dry-run window expires', async () => {
    const expired = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "UPDATE derived_memory_legacy_clear_audit SET finished_at=now()-interval '2 hours' WHERE run_id=$1",
      [expired.runId],
    );
    const next = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRunMaxAgeMs: 60_000,
    });
    expect(next.runId).not.toBe(expired.runId);
    for (const table of [
      'derived_memory_legacy_clear_plan_runs',
      'derived_memory_legacy_clear_plan',
    ]) {
      expect(
        (
          await db.pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE dry_run_id=$1`,
            [expired.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }
  });

  it('stores only row IDs/digests outside counts-only audit and purges plans after success', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    const plan = await db.pool.query(
      'SELECT * FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
      [dry.runId],
    );
    expect(plan.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(plan.rows)).not.toMatch(
      /uncovered legacy summary|legacy fact|legacy searchable document/,
    );
    const ids = plan.rows.flatMap((row) => [
      ...(row.scene_summary_ids ?? []),
      ...(row.registry_entry_ids ?? []),
      ...(row.registry_fact_ids ?? []),
      row.session_id,
    ]);
    const plannedIds = {
      summaries: plan.rows.flatMap((row) => row.scene_summary_ids ?? []),
      entries: plan.rows.flatMap((row) => row.registry_entry_ids ?? []),
      facts: plan.rows.flatMap((row) => row.registry_fact_ids ?? []),
    };
    const audit = await db.pool.query(
      'SELECT counts FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
      [dry.runId],
    );
    expect(JSON.stringify(audit.rows)).not.toMatch(new RegExp(ids.join('|')));
    const live = await runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
    });
    expect(live.outcome).toBe('live_succeeded');
    for (const [table, ids] of [
      ['scene_summaries', plannedIds.summaries],
      ['registry_entries', plannedIds.entries],
      ['registry_facts', plannedIds.facts],
    ] as const) {
      if (ids.length === 0) continue;
      const remaining = await db.pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE id=ANY($1::bigint[])`,
        [ids],
      );
      expect(remaining.rows[0]?.n).toBe(0);
    }
    for (const table of [
      'derived_memory_legacy_clear_plan_runs',
      'derived_memory_legacy_clear_plan',
    ]) {
      expect(
        (
          await db.pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE dry_run_id=$1`,
            [dry.runId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }
  });

  it('aborts before deletion when live counts drift from the dry run and purges its plan', async () => {
    const dry = await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'after-dry-run','new legacy')",
      [sessionIds[0]],
    );
    await expect(
      runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
    ).rejects.toThrow(/plan_digest_mismatch/i);
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
          "SELECT outcome,reason_code FROM derived_memory_legacy_clear_audit WHERE mode='live'",
        )
      ).rows[0]?.outcome,
    ).toBe('aborted');
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM derived_memory_legacy_clear_plan_runs WHERE dry_run_id=$1',
          [dry.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('ignores the count-tolerance environment variable and refuses unreviewed rows', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'after-dry-run','new legacy')",
      [sessionIds[0]],
    );
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_COUNT_TOLERANCE = '5';
    try {
      await expect(
        runLegacyDerivedMemoryClear(db.pool, { ...flags, dryRun: false }),
      ).rejects.toThrow(/plan_digest_mismatch/i);
    } finally {
      delete process.env.DERIVED_MEMORY_LEGACY_CLEAR_COUNT_TOLERANCE;
    }
  });

  it('does not let a caller-supplied old clock make a 30-hour backup attestation fresh', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    const actualAttestation =
      process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT;
    process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT = new Date(
      Date.now() - 30 * 60 * 60_000,
    ).toISOString();
    try {
      await expect(
        runLegacyDerivedMemoryClear(db.pool, {
          ...flags,
          dryRun: false,
          now: () => new Date(Date.now() - 29 * 60 * 60_000),
        }),
      ).rejects.toThrow(/backup attestation/i);
    } finally {
      process.env.DERIVED_MEMORY_LEGACY_CLEAR_BACKUP_CONFIRMED_AT =
        actualAttestation!;
    }
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

  it('does not mark a live run failed when its heartbeat appears older than 15 minutes during deletion', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    let staleHeartbeatChecked = false;
    const livePromise = runLegacyDerivedMemoryClear(db.pool, {
      ...flags,
      dryRun: false,
      runningStaleAfterMs: 15 * 60_000,
      afterSessionIdentityCheckForTests: async (_client, sessionId) => {
        if (sessionId !== sessionIds[0] || staleHeartbeatChecked) return;
        staleHeartbeatChecked = true;
        const running = await db.pool.query<{ run_id: string }>(
          "SELECT run_id FROM derived_memory_legacy_clear_audit WHERE mode='live' AND outcome='running' ORDER BY started_at DESC LIMIT 1",
        );
        const runId = running.rows[0]?.run_id;
        expect(runId).toBeDefined();
        await db.pool.query(
          "UPDATE derived_memory_legacy_clear_audit SET heartbeat_at=clock_timestamp()-interval '16 minutes' WHERE run_id=$1",
          [runId],
        );
        await expect(
          runLegacyDerivedMemoryClear(db.pool, flags),
        ).rejects.toThrow(/advisory lock/i);
        expect(
          (
            await db.pool.query(
              'SELECT outcome FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
              [runId],
            )
          ).rows[0]?.outcome,
        ).toBe('running');
      },
    });

    const live = await livePromise;
    expect(staleHeartbeatChecked).toBe(true);
    expect(live.outcome).toBe('live_succeeded');
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
          'SELECT outcome FROM derived_memory_legacy_clear_audit WHERE run_id=$1',
          [live.runId],
        )
      ).rows[0]?.outcome,
    ).toBe('live_succeeded');
  });

  it('refreshes heartbeat during a slow single-session batch', async () => {
    await runLegacyDerivedMemoryClear(db.pool, flags);
    await db.pool.query(
      `CREATE FUNCTION slow_legacy_clear_summary_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.45); RETURN OLD; END $$`,
    );
    await db.pool.query(
      'CREATE TRIGGER slow_legacy_clear_summary_delete BEFORE DELETE ON scene_summaries FOR EACH ROW EXECUTE FUNCTION slow_legacy_clear_summary_delete()',
    );
    try {
      const live = runLegacyDerivedMemoryClear(db.pool, {
        ...flags,
        dryRun: false,
        heartbeatIntervalMsForTests: 25,
        runningStaleAfterMs: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
      const heartbeat = await db.pool.query<{
        outcome: string;
        age_ms: number;
      }>(
        "SELECT outcome,(extract(epoch FROM clock_timestamp()-heartbeat_at)*1000)::int AS age_ms FROM derived_memory_legacy_clear_audit WHERE mode='live' ORDER BY started_at DESC LIMIT 1",
      );
      expect(heartbeat.rows[0]?.outcome).toBe('running');
      expect(heartbeat.rows[0]?.age_ms).toBeLessThan(100);
      expect((await live).outcome).toBe('live_succeeded');
    } finally {
      await db.pool.query(
        'DROP TRIGGER IF EXISTS slow_legacy_clear_summary_delete ON scene_summaries',
      );
      await db.pool.query(
        'DROP FUNCTION IF EXISTS slow_legacy_clear_summary_delete()',
      );
    }
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
