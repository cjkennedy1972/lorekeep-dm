import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Persistence } from '../../src/persistence/index.js';
import { recoverRoom } from '../../src/room/recovery.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL required for chat expiry integration tests');

const pool = new Pool({ connectionString: databaseUrl });
afterAll(async () => pool.end());

describe('chat event expiry sequence continuity (Postgres)', () => {
  it('preserves recovery sequence while deleting expired raw chat text', async () => {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    const seatId = randomUUID();
    const nodeId = `chat-expiry-${randomUUID()}`;
    const persistence = new Persistence(pool);

    try {
      await pool.query(
        `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
         VALUES($1,$2,'x','Expiry test','active',true,now(),'v1',now())`,
        [accountId, `${accountId}@example.test`],
      );
      await pool.query(
        'INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)',
        [sessionId, accountId],
      );
      await pool.query(
        `INSERT INTO session_lease(session_id,node_id,epoch,expires_at)
         VALUES($1,$2,1,now()+interval '1 hour')`,
        [sessionId, nodeId],
      );
      await pool.query(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         VALUES($1,1,$2,'SeatJoined',$3::jsonb)`,
        [sessionId, randomUUID(), JSON.stringify({ accountId, seatId })],
      );
      await pool.query(
        'INSERT INTO snapshots(session_id,seq,state) VALUES($1,1,$2::jsonb)',
        [sessionId, JSON.stringify({ sessionId, phase: 'lobby', seats: [] })],
      );
      const chat = await persistence.writeChat(
        sessionId,
        {
          turnId: randomUUID(),
          type: 'chat.committed',
          payload: {
            accountId,
            messageId: randomUUID(),
            roomId: sessionId,
            seatId,
            receiptSeq: 1,
            receivedAt: Date.now(),
            text: 'retained only for thirty days',
            channel: 'ooc',
            gateDecision: { verdict: 'allow', moderationLogId: randomUUID() },
          },
        },
        { nodeId, epoch: 1 },
      );
      await pool.query(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         VALUES($1,$2,$3,'Turn','{"next":true}'::jsonb)`,
        [sessionId, chat.seq + 1, randomUUID()],
      );

      await pool.query("SELECT purge_expired_events(now()+interval '31 days')");

      const latest = await persistence.loadLatest(sessionId);
      expect(recoverRoom(sessionId, latest).seq).toBe(chat.seq + 1);
      expect(latest.events.map((event) => event.seq)).toEqual([
        chat.seq,
        chat.seq + 1,
      ]);
      const result = await pool.query<{ payload: unknown }>(
        'SELECT payload FROM events WHERE session_id=$1 AND seq=$2',
        [sessionId, chat.seq],
      );
      expect(result.rows[0]?.payload).toEqual({});
      expect(JSON.stringify(result.rows)).not.toContain(
        'retained only for thirty days',
      );
    } finally {
      await pool.query('SELECT purge_session($1)', [sessionId]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    }
  });
});
