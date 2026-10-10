import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const log = () => {};
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;

async function account(status: string, name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h',$3,$4,true,now(),'v1',now(),now())",
    [id, `${id}@example.test`, name, status],
  );
  return id;
}

async function seat(session: string, accountId: string, seq: number) {
  await q(
    'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$1,$3,$4)',
    [
      session,
      seq,
      'SeatJoined',
      {
        seatId: randomUUID(),
        accountId,
        displayName: 'Seat',
        presence: 'offline',
      },
    ],
  );
}

async function sweep() {
  const dir = await mkdtemp(join(tmpdir(), 'acct-holds-'));
  await runSweep(pool, { store: new LocalObjectStore(dir), log });
  return dir;
}

async function audit(itemId: string) {
  return q(
    'SELECT item_kind, action FROM retention_audit WHERE item_id=$1 ORDER BY item_kind',
    [itemId],
  );
}

describe('account deletion honors legal holds', () => {
  it('a held export defers the account deletion and keeps the archive', async () => {
    const gone = await account('deleting', 'HoldGone');
    const exportId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'acct-export-hold-'));
    await new LocalObjectStore(dir).put(`${exportId}.json`, '{}');
    await q(
      "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed',now() + interval '1 day',$3)",
      [exportId, gone, `${exportId}.json`],
    );
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('export',$1)", [
      exportId,
    ]);
    try {
      await runSweep(pool, { store: new LocalObjectStore(dir), log });

      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [gone]),
      ).toEqual([{ status: 'deleting' }]);
      expect(
        await q('SELECT 1 FROM export_jobs WHERE id=$1', [exportId]),
      ).toHaveLength(1);
      expect(await readdir(dir)).toEqual([`${exportId}.json`]);
      expect(await audit(exportId)).toEqual([
        { item_kind: 'export', action: 'skipped_legal_hold' },
      ]);

      await q("DELETE FROM legal_holds WHERE kind='export' AND item_id=$1", [
        exportId,
      ]);
      await runSweep(pool, { store: new LocalObjectStore(dir), log });
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [exportId]);
      await q('DELETE FROM accounts WHERE id=$1', [gone]);
    }
  });

  it('the audit row for a held session survives the rolled-back deletion', async () => {
    const gone = await account('deleting', 'HoldOwner');
    const session = randomUUID();
    await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
      session,
      gone,
      'Held',
    ]);
    await seat(session, gone, 1);
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
      session,
    ]);
    try {
      await sweep();
      expect(
        await q('SELECT 1 FROM sessions WHERE id=$1', [session]),
      ).toHaveLength(1);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [gone]),
      ).toEqual([{ status: 'deleting' }]);
      expect(await audit(session)).toEqual([
        { item_kind: 'session', action: 'skipped_legal_hold' },
      ]);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [session]);
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id=$1', [gone]);
    }
  });

  it('a held co-seat defers the purge of a shared owned room', async () => {
    const gone = await account('deleting', 'PurgeOwner');
    const coSeat = await account('deleting', 'HeldCoSeat');
    const session = randomUUID();
    await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
      session,
      gone,
      'Shared',
    ]);
    await seat(session, gone, 1);
    await seat(session, coSeat, 2);
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('account',$1)", [
      coSeat,
    ]);
    try {
      await sweep();
      expect(
        await q('SELECT 1 FROM sessions WHERE id=$1', [session]),
      ).toHaveLength(1);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(1);
      expect(await audit(coSeat)).toContainEqual({
        item_kind: 'account',
        action: 'skipped_legal_hold',
      });

      await q('DELETE FROM legal_holds WHERE item_id=$1', [coSeat]);
      await sweep();
      expect(
        await q('SELECT 1 FROM sessions WHERE id=$1', [session]),
      ).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [coSeat]);
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, coSeat]]);
    }
  });

  it('a held export does not drain the live rooms of the held deletion', async () => {
    const gone = await account('deleting', 'DrainGone');
    const heir = await account('active', 'DrainCoPlayer');
    const session = randomUUID();
    const exportId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'acct-drain-hold-'));
    await q('INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)', [
      session,
      gone,
      'Drained',
    ]);
    await seat(session, gone, 1);
    await seat(session, heir, 2);
    await q(
      "INSERT INTO export_jobs(id,account_id,status,expires_at,archive_key) VALUES($1,$2,'completed',now() + interval '1 day',$3)",
      [exportId, gone, `${exportId}.json`],
    );
    await new LocalObjectStore(dir).put(`${exportId}.json`, '{}');
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('export',$1)", [
      exportId,
    ]);
    const drained: string[] = [];
    const drainRoom = async (id: string) => {
      drained.push(id);
    };
    try {
      await runSweep(pool, {
        store: new LocalObjectStore(dir),
        log,
        drainRoom,
      });
      await runSweep(pool, {
        store: new LocalObjectStore(dir),
        log,
        drainRoom,
      });
      expect(drained).not.toContain(session);
      expect(
        await q('SELECT status FROM accounts WHERE id=$1', [gone]),
      ).toEqual([{ status: 'deleting' }]);

      await q("DELETE FROM legal_holds WHERE kind='export' AND item_id=$1", [
        exportId,
      ]);
      await runSweep(pool, {
        store: new LocalObjectStore(dir),
        log,
        drainRoom,
      });
      expect(drained).toContain(session);
      expect(
        await q('SELECT 1 FROM accounts WHERE id=$1', [gone]),
      ).toHaveLength(0);
    } finally {
      await q('DELETE FROM legal_holds WHERE item_id=$1', [exportId]);
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
