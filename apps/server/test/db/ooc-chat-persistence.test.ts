import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Persistence,
  ChatSeatRevokedError,
} from '../../src/persistence/index.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

async function migrate(database: TestDatabase) {
  const names = (await readdir(new URL('../../migrations/', import.meta.url)))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const name of names)
    await database.pool.query(
      await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      ),
    );
}

describe('OOC chat persistence (postgres)', () => {
  let database: TestDatabase;
  let persistence: Persistence;
  let sessionId: string;
  let accountId: string;
  let seatId: string;
  let moderationLogId: string;
  const lease = { nodeId: 'ooc-chat-test', epoch: 1 };

  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await migrate(database);
    persistence = new Persistence(database.pool);
    accountId = randomUUID();
    sessionId = randomUUID();
    seatId = randomUUID();
    moderationLogId = randomUUID();
    await database.pool.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x','Chat player','active',true,now(),'v1',now())`,
      [accountId, `${accountId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,'Chat test')",
      [sessionId, accountId],
    );
    await database.pool.query(
      `INSERT INTO session_lease(session_id,node_id,epoch,expires_at)
       VALUES($1,$2,$3,now()+interval '1 minute')`,
      [sessionId, lease.nodeId, lease.epoch],
    );
    await database.pool.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       VALUES($1,1,$2,'SeatJoined',$3::jsonb)`,
      [
        sessionId,
        randomUUID(),
        JSON.stringify({ accountId, seatId, displayName: 'Chat player' }),
      ],
    );
    await database.pool.query(
      `INSERT INTO moderation_log(id,surface,account_id,session_id,category,source,expires_at)
       VALUES($1,'chat',$2,$3,'none','judge',now()+interval '30 days')`,
      [moderationLogId, accountId, sessionId],
    );
  });

  afterEach(async () => database.close());

  const chatEvent = (messageId = randomUUID()) => ({
    turnId: randomUUID(),
    type: 'chat.committed',
    payload: {
      accountId,
      messageId,
      roomId: sessionId,
      seatId,
      receiptSeq: 1,
      receivedAt: Date.now(),
      text: '  Hello party  '.trim(),
      channel: 'ooc',
      gateDecision: { verdict: 'allow', moderationLogId },
    },
  });

  it('stores an expiring committed message and returns history without the private account id', async () => {
    const stored = await persistence.writeChat(sessionId, chatEvent(), lease);
    expect(stored.seq).toBe(2);
    const row = (
      await database.pool.query(
        `SELECT payload,
                expires_at > now()+interval '29 days' AND expires_at <= now()+interval '30 days' AS retained_30_days
           FROM events WHERE session_id=$1 AND seq=$2`,
        [sessionId, stored.seq],
      )
    ).rows[0];
    expect(row.payload).toHaveProperty('accountId', accountId);
    expect(row.payload).toHaveProperty('text', 'Hello party');
    expect(row.retained_30_days).toBe(true);

    const history = await persistence.loadChatHistory(sessionId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      seq: 2,
      message: { text: 'Hello party', seatId, roomId: sessionId },
    });
    expect(JSON.stringify(history)).not.toContain(accountId);
  });

  it('rejects a commit if the seat was revoked after the sender snapshot was read', async () => {
    await database.pool.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       VALUES($1,2,$2,'SeatRevoked',$3::jsonb)`,
      [sessionId, randomUUID(), JSON.stringify({ seatId })],
    );
    await expect(
      persistence.writeChat(sessionId, chatEvent(), lease),
    ).rejects.toBeInstanceOf(ChatSeatRevokedError);
    expect(
      await database.pool.query(
        "SELECT 1 FROM events WHERE session_id=$1 AND type='chat.committed'",
        [sessionId],
      ),
    ).toMatchObject({ rowCount: 0 });
  });
});
