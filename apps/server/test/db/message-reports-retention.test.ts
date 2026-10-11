import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createSession } from '../../src/accounts/sessions.js';
import { purgeExpiredReports } from '../../src/retention/jobs/reports.js';
import { purgeArchivedSessions } from '../../src/retention/jobs/sessions.js';
import { runAccountDeletions } from '../../src/retention/jobs/accountDeletion.js';
import { runSweep } from '../../src/retention/sweeper.js';
import { registerReportRoutes } from '../../src/routes/reports.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const HOST = 'http://lorekeep.test';
const DAY = 86_400_000;
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const store = new LocalObjectStore(
  await mkdtemp(join(tmpdir(), 'lk-report-retention-')),
);
const ctx = (now = new Date()) => ({
  db: pool,
  store,
  now,
  log: () => {},
});

async function account(name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h',$3,'active',true,now(),'v1',now())",
    [id, `${id}@example.test`, name],
  );
  return id;
}

async function markDeleting(id: string) {
  await q(
    "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
    [id],
  );
}

async function session(owner: string, status = 'active', archivedAt?: Date) {
  const id = randomUUID();
  await q(
    'INSERT INTO sessions(id,owner_account_id,name,status,archived_at) VALUES($1,$2,$3,$4,$5)',
    [id, owner, 'Table', status, archivedAt ?? null],
  );
  return id;
}

async function insertReport(
  sessionId: string,
  expiresAt: Date,
  reporter: string | null = null,
) {
  const id = randomUUID();
  await q(
    `INSERT INTO message_reports(id,session_id,message_seq,reporter_account_id,category,context,expires_at)
     VALUES($1,$2,1,$3,'other','[]',$4)`,
    [id, sessionId, reporter, expiresAt],
  );
  return id;
}

async function insertAudit(reportId: string, expiresAt: Date) {
  await q(
    'INSERT INTO message_report_audit(report_id,from_status,to_status,expires_at) VALUES($1,$2,$3,$4)',
    [reportId, 'open', 'dismissed', expiresAt],
  );
}

const reportExists = async (id: string) =>
  (await q('SELECT 1 FROM message_reports WHERE id=$1', [id])).length === 1;

describe('message report retention (Postgres)', () => {
  it('purges expired reports and audit rows through the sweeper and keeps live ones', async () => {
    const owner = await account('Keeper');
    const sid = await session(owner);
    const expired = await insertReport(sid, ago(1));
    const live = await insertReport(sid, new Date(Date.now() + DAY));
    await insertAudit(expired, ago(1));
    await insertAudit(live, new Date(Date.now() + DAY));

    const sweep = await runSweep(pool, { store, log: () => {} });

    expect(sweep?.reports.deleted).toBeGreaterThanOrEqual(1);
    expect(await reportExists(expired)).toBe(false);
    expect(await reportExists(live)).toBe(true);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM message_report_audit WHERE report_id=$1',
          [expired],
        )
      )[0].n,
    ).toBe(0);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM message_report_audit WHERE report_id=$1',
          [live],
        )
      )[0].n,
    ).toBe(1);
  });

  it('skips expired reports under a session legal hold and logs the skip', async () => {
    const owner = await account('Held Keeper');
    const sid = await session(owner);
    const held = await insertReport(sid, ago(1));
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
      sid,
    ]);

    const result = await purgeExpiredReports(ctx());

    expect(result.held).toBeGreaterThanOrEqual(1);
    expect(await reportExists(held)).toBe(true);
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM retention_audit WHERE job='reports' AND item_id=$1 AND action='skipped_legal_hold'",
          [sid],
        )
      )[0].n,
    ).toBeGreaterThanOrEqual(1);
  });

  it('removes a session reports when the session is purged', async () => {
    const owner = await account('Purged Keeper');
    const sid = await session(owner);
    const report = await insertReport(sid, new Date(Date.now() + DAY));
    await insertAudit(report, new Date(Date.now() + DAY));

    await q('SELECT purge_session($1)', [sid]);

    expect(await reportExists(report)).toBe(false);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM message_report_audit WHERE report_id=$1',
          [report],
        )
      )[0].n,
    ).toBe(0);
  });

  it('removes the reports of a session archived past 90 days', async () => {
    const owner = await account('Archived Keeper');
    const sid = await session(owner, 'archived', ago(100));
    const report = await insertReport(sid, new Date(Date.now() + DAY));

    await purgeArchivedSessions(ctx());

    expect(await reportExists(report)).toBe(false);
  });

  it('keeps no names or ids in a snapshot after the reporter or the author is deleted by the account-deletion job', async () => {
    const keeper = await account('Keeper Kim');
    const reporter = await account('Hollis Host');
    const author = await account('Quinn Seated');
    const sid = randomUUID();
    await q(
      "INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,'Table')",
      [sid, keeper],
    );
    const events: [number, string, Record<string, unknown>][] = [
      [1, 'SeatJoined', { accountId: keeper, displayName: 'Keeper Kim' }],
      [2, 'SeatJoined', { accountId: reporter, displayName: 'Hollis Host' }],
      [3, 'SeatJoined', { accountId: author, displayName: 'Quinn Seated' }],
      [
        4,
        'ActionAccepted',
        {
          accountId: author,
          playerName: 'Quinn Seated',
          text: 'I hit the goblin.',
          actionId: 'a1',
        },
      ],
    ];
    for (const [seq, type, payload] of events)
      await q(
        'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,$4,$5)',
        [sid, seq, randomUUID(), type, JSON.stringify(payload)],
      );

    const app = Fastify();
    registerReportRoutes(app, pool);
    const cookie = `sid=${await createSession(pool, reporter, 'test', new Date(Date.now() + DAY))}`;
    const posted = await app.inject({
      method: 'POST',
      url: `/api/rooms/${sid}/reports`,
      headers: { cookie, origin: HOST, host: 'lorekeep.test' },
      payload: {
        messageRef: 4,
        category: 'harassment',
        reason: 'Quinn is rude',
      },
    });
    expect(posted.statusCode).toBe(202);
    const id = (
      await q('SELECT id FROM message_reports WHERE session_id=$1', [sid])
    )[0].id as string;

    await markDeleting(reporter);
    await runAccountDeletions(ctx());
    const afterReporter = (
      await q(
        'SELECT reporter_account_id,reason,context,author_account_id FROM message_reports WHERE id=$1',
        [id],
      )
    )[0];
    expect(afterReporter.reporter_account_id).toBeNull();
    expect(afterReporter.reason).toBe('');
    expect(JSON.stringify(afterReporter.context)).not.toContain(reporter);
    expect(JSON.stringify(afterReporter.context)).not.toContain('Hollis');

    await markDeleting(author);
    await runAccountDeletions(ctx());
    const afterAuthor = (
      await q(
        'SELECT author_account_id,context FROM message_reports WHERE id=$1',
        [id],
      )
    )[0];
    const dump = JSON.stringify(afterAuthor.context);
    expect(afterAuthor.author_account_id).toBeNull();
    expect(dump).not.toContain(author);
    expect(dump).not.toContain('Quinn');
    expect(dump).toContain('I hit the goblin.');
  });
});
