import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const MEMBER_SQL = `SELECT s.id FROM sessions s WHERE s.status='active' AND (s.owner_account_id=$1 OR EXISTS (
    SELECT 1 FROM events e WHERE e.session_id=s.id AND e.type='SeatJoined' AND e.payload->>'accountId'=$1::text))`;
let db: Pool;
let member: string;
let joinedSession: string;
let strangerSession: string;

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  member = randomUUID();
  const owner = randomUUID();
  for (const id of [member, owner])
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','M','active',true,now(),'v1',now())`,
      [id, `${id}@example.test`],
    );
  joinedSession = randomUUID();
  strangerSession = randomUUID();
  for (const id of [joinedSession, strangerSession]) {
    await db.query(
      `INSERT INTO sessions(id,owner_account_id,name,status) VALUES($1,$2,'Membership','active')`,
      [id, owner],
    );
  }
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3::jsonb)`,
    [joinedSession, randomUUID(), JSON.stringify({ accountId: member })],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3::jsonb)`,
    [strangerSession, randomUUID(), JSON.stringify({ accountId: owner })],
  );
});

afterAll(async () => {
  await db.end();
});

describe('seat membership lookup', () => {
  it('returns the same rooms as the event-log scan', async () => {
    const rows = await db.query<{ id: string }>(MEMBER_SQL, [member]);
    expect(rows.rows.map((r) => r.id)).toEqual([joinedSession]);
  });

  it('is served by an index on seat-joined events', async () => {
    const index = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='events' AND indexname='events_seat_joined_account_idx'`,
    );
    expect(index.rowCount).toBe(1);
    const client = await db.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(`EXPLAIN ${MEMBER_SQL}`, [member]);
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('events_seat_joined_account_idx');
    } finally {
      client.release();
    }
  });
});
