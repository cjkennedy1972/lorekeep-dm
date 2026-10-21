import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;

async function account(name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h',$3,'deleting',true,now(),'v1',now(),now())",
    [id, `${id}@example.test`, name],
  );
  return id;
}

async function activeAccount(name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h',$3,'active',true,now(),'v1',now())",
    [id, `${id}@example.test`, name],
  );
  return id;
}

async function chatEvent(sessionId: string, accountId: string, text: string) {
  await q(
    "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'chat.committed',$2)",
    [
      sessionId,
      {
        accountId,
        seatId: randomUUID(),
        text,
        createdAt: new Date().toISOString(),
      },
    ],
  );
}

describe('account deletion and chat history', () => {
  it('replaces authored chat text, preserves its event and ordering, scrubs its author, and honors a session legal hold', async () => {
    const gone = await account('Gone');
    const held = await account('Held');
    const host = await activeAccount('Host');
    const session = randomUUID();
    const heldSession = randomUUID();
    await q('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2),($3,$4)', [
      session,
      host,
      heldSession,
      held,
    ]);
    await chatEvent(session, gone, 'private chat');
    await chatEvent(heldSession, held, 'held chat');
    await q("INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)", [
      heldSession,
    ]);

    await runSweep(pool, {
      store: new LocalObjectStore(await mkdtemp(join(tmpdir(), 'chat-del-'))),
      log: () => {},
    });

    const [redacted] = await q(
      "SELECT seq,type,payload FROM events WHERE session_id=$1 AND type='chat.committed'",
      [session],
    );
    expect(redacted).toMatchObject({
      seq: '1',
      type: 'chat.committed',
      payload: { text: '[removed]' },
    });
    expect(redacted.payload.accountId).not.toBe(gone);
    expect(await q('SELECT id FROM accounts WHERE id=$1', [gone])).toHaveLength(
      0,
    );

    const [unchanged] = await q(
      "SELECT payload FROM events WHERE session_id=$1 AND type='chat.committed'",
      [heldSession],
    );
    expect(unchanged.payload).toMatchObject({
      accountId: held,
      text: 'held chat',
    });
    expect(await q('SELECT id FROM accounts WHERE id=$1', [held])).toHaveLength(
      1,
    );
  });
});
