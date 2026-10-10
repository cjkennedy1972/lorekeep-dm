import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';
import { createSession } from '../../src/accounts/sessions.js';
import { processExport } from '../../src/accounts/export.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());

const PASSWORD = 'correct-password-1';
const TWENTY_FIVE_MB = 25 * 1024 * 1024;

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,$3,'Player','active',true,now(),'t',now())`,
    [id, `${id}@example.test`, await hashPassword(PASSWORD)],
  );
  return id;
}

describe('export abuse limits', () => {
  it('throttles password guesses per account across IPs, before any password check', async () => {
    const id = await account();
    const token = await createSession(db, id, 'Test device');
    const app = createApp(db, { cookieSecret: 'test-secret' });
    const post = (ip: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/me/export',
        remoteAddress: ip,
        headers: { cookie: `sid=${token}` },
        payload: { password },
      });

    for (let i = 0; i < 5; i++)
      expect((await post('10.4.0.1', 'wrong-password-1')).statusCode).toBe(403);
    expect((await post('10.4.0.1', PASSWORD)).statusCode).toBe(429);
    expect((await post('10.4.0.2', PASSWORD)).statusCode).toBe(429);
    const jobs = await db.query(
      'SELECT count(*)::int AS n FROM export_jobs WHERE account_id=$1',
      [id],
    );
    expect(jobs.rows[0].n).toBe(0);
    await app.close();
  });

  it('caps exports per account per week', async () => {
    const id = await account();
    const token = await createSession(db, id, 'Test device');
    for (let i = 0; i < 10; i++)
      await db.query(
        "INSERT INTO export_jobs(id,account_id,status,requested_at) VALUES($1,$2,'completed',now() - interval '1 day')",
        [randomUUID(), id],
      );
    const app = createApp(db, { cookieSecret: 'test-secret' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/me/export',
      remoteAddress: '10.4.1.1',
      headers: { cookie: `sid=${token}` },
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    const jobs = await db.query(
      'SELECT count(*)::int AS n FROM export_jobs WHERE account_id=$1',
      [id],
    );
    expect(jobs.rows[0].n).toBe(10);
    await app.close();
  });

  it('refuses to store an archive above the size cap', async () => {
    const owner = await account();
    const room = randomUUID();
    const jobId = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode) VALUES($1,$2,'Big','active','solo')",
      [room, owner],
    );
    await db.query(
      'INSERT INTO snapshots(session_id,seq,state) VALUES($1,1,$2::jsonb)',
      [
        room,
        JSON.stringify({
          sessionId: randomUUID(),
          phase: 'lobby',
          seats: [],
          gameState: { premise: 'x'.repeat(TWENTY_FIVE_MB) },
        }),
      ],
    );
    await db.query(
      "INSERT INTO export_jobs(id,account_id,status) VALUES($1,$2,'pending')",
      [jobId, owner],
    );
    const put: string[] = [];
    await processExport(db, jobId, owner, {
      put: async (key) => {
        put.push(key);
      },
      get: async () => '',
      delete: async () => {},
    });
    const row = (
      await db.query(
        'SELECT status, error_code FROM export_jobs WHERE id=$1',
        [jobId],
      )
    ).rows[0];
    expect(put).toEqual([]);
    expect(row).toEqual({ status: 'failed', error_code: 'EXPORT_TOO_LARGE' });
  });
});
