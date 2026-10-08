import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { retentionHealth, runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const logs: Record<string, unknown>[] = [];
const log = (e: Record<string, unknown>) => void logs.push(e);
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;
const count = async (sql: string, p: unknown[]) =>
  (await q(sql, p))[0].n as number;

async function account(status: string, name = 'Player') {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h',$3,$4,true,now(),'v1',now(),now())",
    [id, `${id}@example.test`, name, status],
  );
  return id;
}
async function seatEvent(
  session: string,
  seq: number,
  accountId: string,
  name: string,
) {
  const seatId = randomUUID();
  await q(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$1,$3,$4)',
    [
      session,
      seq,
      'SeatJoined',
      { seatId, accountId, displayName: name, presence: 'offline' },
    ],
  );
  return seatId;
}

describe('retention sweeper (Postgres)', () => {
  it('deletes only expired rows, then a second sweep deletes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-'));
    const store = new LocalObjectStore(dir);
    const acc = await account('active');
    const sess = randomUUID();
    await q('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      sess,
      acc,
    ]);
    for (const [seq, exp] of [
      [1, '2020-01-01'],
      [2, '2099-01-01'],
      [3, null],
    ] as const)
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload,expires_at) VALUES($1,$2,$1,'Log','{}',$3)",
        [sess, seq, exp],
      );
    await q(
      `INSERT INTO operator_endpoint_audit(slot,action,actor_id,expires_at) VALUES
       ('fast','tested',$1,'2020-01-01'),('frontier','tested',$1,'2099-01-01')`,
      [acc],
    );
    const oldTok = `old-${randomUUID()}`,
      newTok = `new-${randomUUID()}`;
    for (const [t, exp] of [
      [oldTok, '2020-01-01'],
      [newTok, '2099-01-01'],
    ])
      await q(
        "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES($1,$2,'verify',$3)",
        [t, acc, exp],
      );
    const expired = randomUUID(),
      live = randomUUID();
    for (const [id, exp] of [
      [expired, '2020-01-01'],
      [live, '2099-01-01'],
    ]) {
      await store.put(`${id}.json`, '{}');
      await q(
        "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed',$3,$4)",
        [id, acc, exp, `${id}.json`],
      );
    }
    await runSweep(pool, { store, log });
    expect(
      await q('SELECT seq FROM events WHERE session_id=$1 ORDER BY seq', [
        sess,
      ]),
    ).toEqual([{ seq: '2' }, { seq: '3' }]);
    expect(
      await count(
        'SELECT count(*)::int n FROM operator_endpoint_audit WHERE actor_id=$1',
        [acc],
      ),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*)::int n FROM email_tokens WHERE account_id=$1',
        [acc],
      ),
    ).toBe(1);
    expect(
      (await q('SELECT id FROM export_jobs WHERE account_id=$1', [acc])).map(
        (r) => r.id,
      ),
    ).toEqual([live]);
    expect(await readdir(dir)).toEqual([`${live}.json`]);
    logs.length = 0;
    await runSweep(pool, { store, log });
    const logsRow = logs.find((l) => l.job === 'logs')!;
    expect([logsRow.events, logsRow.emailTokens]).toEqual([0, 0]);
    expect(logs.find((l) => l.job === 'exports')!.deleted).toBe(0);
    expect((await retentionHealth(pool)).stale).toBe(false);
  });

  it('fully removes a deleting account, hands off/deletes rooms, anonymizes seats, and is a no-op twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-'));
    const store = new LocalObjectStore(dir);
    const gone = await account('deleting', 'SecretName');
    const friend = await account('active', 'Friend');
    const solo = randomUUID(),
      shared = randomUUID();
    await q('INSERT INTO sessions(id,owner_account_id) VALUES($1,$3),($2,$3)', [
      solo,
      shared,
      gone,
    ]);
    await seatEvent(solo, 1, gone, 'SecretName');
    const seatId = await seatEvent(shared, 1, gone, 'SecretName');
    await seatEvent(shared, 2, friend, 'Friend');
    await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,2,$2)', [
      shared,
      { seats: [{ seatId, accountId: gone, displayName: 'SecretName' }] },
    ]);
    await q(
      "INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES($1,$2,'2099-01-01','2099-01-01',now())",
      [`t-${gone}`, gone],
    );
    await q(
      "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES($1,$2,'reset','2099-01-01')",
      [`e-${gone}`, gone],
    );
    await q(
      "INSERT INTO ws_tickets(ticket_hash,account_id,session_id,auth_token_hash,expires_at) VALUES($1,$2,$3,$4,'2099-01-01')",
      [`w-${gone}`, gone, shared, `t-${gone}`],
    );
    const exp = randomUUID();
    await store.put(`${exp}.json`, '{"pii":1}');
    await q(
      "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed','2099-01-01',$3)",
      [exp, gone, `${exp}.json`],
    );
    await q('INSERT INTO deletion_jobs(id,account_id) VALUES($1,$1)', [
      gone,
    ]).catch(() =>
      q('INSERT INTO deletion_jobs(id,account_id) VALUES($1,$2)', [
        randomUUID(),
        gone,
      ]),
    );

    await runSweep(pool, { store, log });

    for (const t of [
      'accounts WHERE id',
      'auth_sessions WHERE account_id',
      'email_tokens WHERE account_id',
      'ws_tickets WHERE account_id',
      'export_jobs WHERE account_id',
      'deletion_jobs WHERE account_id',
    ])
      expect(await count(`SELECT count(*)::int n FROM ${t}=$1`, [gone])).toBe(
        0,
      );
    expect(await readdir(dir)).toEqual([]);
    expect(
      await count('SELECT count(*)::int n FROM sessions WHERE id=$1', [solo]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int n FROM events WHERE session_id=$1', [
        solo,
      ]),
    ).toBe(0);
    expect(
      (
        await q('SELECT owner_account_id FROM sessions WHERE id=$1', [shared])
      )[0].owner_account_id,
    ).toBe(friend);
    const ev = (
      await q('SELECT payload FROM events WHERE session_id=$1 AND seq=1', [
        shared,
      ])
    )[0].payload;
    expect(ev).toMatchObject({
      displayName: 'Deleted player',
      accountId: seatId,
      anonymized: true,
    });
    expect(
      JSON.stringify(
        await q('SELECT state FROM snapshots WHERE session_id=$1', [shared]),
      ),
    ).not.toContain('SecretName');
    expect(JSON.stringify(logs)).not.toContain('@example.test');
    expect(JSON.stringify(logs)).not.toContain('SecretName');

    logs.length = 0;
    await runSweep(pool, { store, log });
    expect(
      logs.find((l) => l.job === 'accountDeletion' && 'deleted' in l),
    ).toMatchObject({ deleted: 0, held: 0, failed: 0 });
  });

  it('skips and audits held items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-'));
    const store = new LocalObjectStore(dir);
    const held = await account('deleting');
    const heldExport = randomUUID();
    const owner = await account('active');
    await store.put(`${heldExport}.json`, '{}');
    await q(
      "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed','2020-01-01',$3)",
      [heldExport, owner, `${heldExport}.json`],
    );
    await q(
      "INSERT INTO legal_holds(kind,item_id) VALUES('account',$1),('export',$2)",
      [held, heldExport],
    );
    await runSweep(pool, { store, log });
    expect(
      await count('SELECT count(*)::int n FROM accounts WHERE id=$1', [held]),
    ).toBe(1);
    expect(
      await count('SELECT count(*)::int n FROM export_jobs WHERE id=$1', [
        heldExport,
      ]),
    ).toBe(1);
    expect(await readdir(dir)).toEqual([`${heldExport}.json`]);
    const audit = await q(
      'SELECT item_kind,action FROM retention_audit WHERE item_id = ANY($1) ORDER BY item_kind',
      [[held, heldExport]],
    );
    expect(audit).toEqual([
      { item_kind: 'account', action: 'skipped_legal_hold' },
      { item_kind: 'export', action: 'skipped_legal_hold' },
    ]);
    await q('DELETE FROM legal_holds WHERE item_id = ANY($1)', [
      [held, heldExport],
    ]);
  });
});
