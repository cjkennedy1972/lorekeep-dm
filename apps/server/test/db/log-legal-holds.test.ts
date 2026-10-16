import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { purgeLogs } from '../../src/retention/jobs/logs.js';
import { LocalObjectStore } from '../../src/storage/objectStore.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;
const count = async (sql: string, p: unknown[]) =>
  Number((await q(sql, p))[0].n);
const NOW = new Date('2026-10-08T00:00:00Z');
const ctx = async () => ({
  db: pool,
  store: new LocalObjectStore(await mkdtemp(join(tmpdir(), 'logs-hold-'))),
  now: NOW,
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

async function session(owner: string) {
  const id = randomUUID();
  await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
    id,
    owner,
    'Table',
  ]);
  return id;
}

const expiredModeration = (
  sessionId: string | null,
  accountId: string | null = null,
) =>
  q(
    `INSERT INTO moderation_log(surface,session_id,account_id,category,source,written_at,expires_at)
     VALUES('player-action',$1,$2,'other','judge','2020-01-01','2020-01-31') RETURNING id`,
    [sessionId, accountId],
  );

const expiredXCard = (sessionId: string) =>
  q(
    `INSERT INTO x_card_log(session_id,seat_id,written_at,expires_at)
     VALUES($1,$2,'2020-01-01','2020-01-31')`,
    [sessionId, randomUUID()],
  );

describe('log retention honors legal holds (Postgres)', () => {
  it('keeps expired moderation rows whose account is held even with no session, and purges unheld-account rows', async () => {
    const heldAcc = await account('Held Author');
    const freeAcc = await account('Free Author');
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('account',$1)", [
      heldAcc,
    ]);
    const heldRow = (await expiredModeration(null, heldAcc))[0].id;
    const freeRow = (await expiredModeration(null, freeAcc))[0].id;

    await purgeLogs(await ctx());
    await purgeLogs(await ctx());

    expect(
      await count('SELECT count(*)::int n FROM moderation_log WHERE id=$1', [
        heldRow,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::int n FROM moderation_log WHERE id=$1', [
        freeRow,
      ]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int n FROM retention_audit WHERE job='logs' AND item_kind='account' AND item_id=$1 AND action='skipped_legal_hold'",
        [heldAcc],
      ),
    ).toBe(1);

    await q('DELETE FROM legal_holds WHERE item_id=$1', [heldAcc]);
  });

  it('keeps an expired moderation row held by its account even when its session is unheld', async () => {
    const owner = await account('Owner');
    const sid = await session(owner);
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('account',$1)", [
      owner,
    ]);
    const row = (await expiredModeration(sid, owner))[0].id;

    await purgeLogs(await ctx());

    expect(
      await count('SELECT count(*)::int n FROM moderation_log WHERE id=$1', [
        row,
      ]),
    ).toBe(1);

    await q('DELETE FROM legal_holds WHERE item_id=$1', [owner]);
  });

  it('keeps expired moderation and x-card rows of a held session, purges an unheld session, and audits the hold once', async () => {
    const owner = await account('Keeper');
    const held = await session(owner);
    const free = await session(owner);
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
      held,
    ]);
    await expiredModeration(held);
    await expiredModeration(free);
    const nullSession = (await expiredModeration(null))[0].id;
    await expiredXCard(held);
    await expiredXCard(free);

    await purgeLogs(await ctx());
    await purgeLogs(await ctx());

    expect(
      await count(
        'SELECT count(*)::int n FROM moderation_log WHERE session_id=$1',
        [held],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int n FROM x_card_log WHERE session_id=$1',
        [held],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int n FROM moderation_log WHERE session_id=$1',
        [free],
      ),
    ).toBe(0);
    expect(
      await count(
        'SELECT count(*)::int n FROM x_card_log WHERE session_id=$1',
        [free],
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int n FROM moderation_log WHERE id=$1', [
        nullSession,
      ]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int n FROM retention_audit WHERE job='logs' AND item_kind='session' AND item_id=$1 AND action='skipped_legal_hold'",
        [held],
      ),
    ).toBe(1);

    await q('DELETE FROM legal_holds WHERE item_id=$1', [held]);
  });

  it('keeps expired operator endpoint audit rows of an account under legal hold and purges the rest', async () => {
    const heldActor = await account('Held Operator');
    const freeActor = await account('Free Operator');
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('account',$1)", [
      heldActor,
    ]);
    for (const actor of [heldActor, freeActor])
      await q(
        "INSERT INTO operator_endpoint_audit(slot,action,actor_id,expires_at) VALUES('fast','tested',$1,'2020-01-01')",
        [actor],
      );

    await purgeLogs(await ctx());

    expect(
      await count(
        'SELECT count(*)::int n FROM operator_endpoint_audit WHERE actor_id=$1',
        [heldActor],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int n FROM operator_endpoint_audit WHERE actor_id=$1',
        [freeActor],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int n FROM retention_audit WHERE job='logs' AND item_kind='account' AND item_id=$1 AND action='skipped_legal_hold'",
        [heldActor],
      ),
    ).toBe(1);

    await q('DELETE FROM legal_holds WHERE item_id=$1', [heldActor]);
  });
});
