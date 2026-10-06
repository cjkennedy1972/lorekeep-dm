import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('game core migration', () => {
 it('enforces event identity, append-only writes, redaction, and lease uniqueness', async () => {
  const client = await pool.connect();
  const id = randomUUID();
  try {
   await client.query('BEGIN');
   await client.query('INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,$4,true,now(),$5,now())',[id,`${id}@example.test`,'hash','Player','v1']);
   await client.query('INSERT INTO sessions(id,owner_account_id) VALUES ($1,$1)', [id]);
   await client.query('INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES ($1,1,$1,$2,$3)', [id,'Turn',{}]);
   await client.query('SAVEPOINT duplicate');
   await expect(client.query('INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES ($1,1,$1,$2,$3)', [id,'Turn',{}])).rejects.toThrow();
   await client.query('ROLLBACK TO duplicate');
   await client.query('SAVEPOINT mutation');
   await expect(client.query('UPDATE events SET type=$2 WHERE session_id=$1',[id,'Changed'])).rejects.toThrow(/append-only/);
   await client.query('ROLLBACK TO mutation');
   await client.query('SAVEPOINT mutation');
   await expect(client.query('DELETE FROM events WHERE session_id=$1',[id])).rejects.toThrow(/append-only/);
   await client.query('ROLLBACK TO mutation');
   await client.query('SELECT redact_event($1,1,$2)',[id,{redacted:true}]);
   expect((await client.query('SELECT payload FROM events WHERE session_id=$1',[id])).rows[0].payload).toEqual({redacted:true});
   await client.query('SAVEPOINT mutation');
   await expect(client.query('DELETE FROM events WHERE session_id=$1',[id])).rejects.toThrow(/append-only/);
   await client.query('ROLLBACK TO mutation');
   await client.query('INSERT INTO session_lease VALUES ($1,$2,now())',[id,'a']);
   await client.query('SAVEPOINT duplicate');
   await expect(client.query('INSERT INTO session_lease VALUES ($1,$2,now())',[id,'b'])).rejects.toThrow();
   await client.query('ROLLBACK TO duplicate');
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
 });
});
