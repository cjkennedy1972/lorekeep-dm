import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
describe('accounts migration', () => {
  it('has no forbidden PII columns, unique case-insensitive email, and cascading tokens', async () => {
    const client = await pool.connect();
    const id = randomUUID(),
      sessionId = randomUUID();
    try {
      await client.query('BEGIN');
      const forbidden = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* '(birth_?date|dob|age_?band|guardian|consent)'`,
      );
      expect(forbidden.rows).toEqual([]);
      const create = async (accountId: string, email: string) =>
        client.query(
          'INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,$4,true,now(),$5,now())',
          [accountId, email, 'hash', 'Player', 'v1'],
        );
      await create(id, 'TEST@example.test');
      await client.query('SAVEPOINT duplicate');
      await expect(create(randomUUID(), 'test@EXAMPLE.test')).rejects.toThrow();
      await client.query('ROLLBACK TO duplicate');
      await client.query(
        'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$2)',
        [sessionId, id],
      );
      await client.query(
        'INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES ($1,$2,now(),now(),now())',
        ['auth', id],
      );
      await client.query(
        'INSERT INTO ws_tickets(ticket_hash,account_id,session_id,auth_token_hash,expires_at) VALUES ($1,$2,$3,$4,now())',
        ['ws', id, sessionId, 'auth'],
      );
      await client.query(
        'INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,$3,now())',
        ['email', id, 'verify'],
      );
      await client.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
      await client.query('DELETE FROM accounts WHERE id=$1', [id]);
      for (const table of ['auth_sessions', 'ws_tickets', 'email_tokens'])
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1`,
              [id],
            )
          ).rows[0].n,
        ).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
