import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword, verifyPassword } from '../../src/accounts/password.js';
import { createSession } from '../../src/accounts/sessions.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());

const PASSWORD = 'correct-password-1';

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,$3,'Player','active',true,now(),'t',now())`,
    [id, `${id}@example.test`, await hashPassword(PASSWORD)],
  );
  return id;
}

describe('password-check abuse limits', () => {
  it('throttles wrong current-password guesses on password change across IPs', async () => {
    const id = await account();
    const token = await createSession(db, id, 'Test device');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const change = (ip: string, currentPassword: string) =>
      app.inject({
        method: 'POST',
        url: '/api/me/password',
        remoteAddress: ip,
        headers: { cookie: `sid=${token}` },
        payload: { currentPassword, newPassword: 'brand-new-password-1' },
      });

    for (let i = 0; i < 5; i++)
      expect((await change('10.5.0.1', 'wrong-password-1')).statusCode).toBe(
        403,
      );
    expect((await change('10.5.0.1', PASSWORD)).statusCode).toBe(429);
    expect((await change('10.5.0.2', PASSWORD)).statusCode).toBe(429);
    const row = await db.query(
      'SELECT password_hash FROM accounts WHERE id=$1',
      [id],
    );
    expect(await verifyPassword(row.rows[0].password_hash, PASSWORD)).toBe(
      true,
    );
    await app.close();
  });

  it('throttles wrong passwords on account deletion and keeps the account active', async () => {
    const id = await account();
    const token = await createSession(db, id, 'Test device');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const remove = (ip: string, password: string) =>
      app.inject({
        method: 'DELETE',
        url: '/api/me',
        remoteAddress: ip,
        headers: { cookie: `sid=${token}` },
        payload: { password, confirmation: 'DELETE MY ACCOUNT' },
      });

    for (let i = 0; i < 5; i++)
      expect((await remove('10.6.0.1', 'wrong-password-1')).statusCode).toBe(
        403,
      );
    expect((await remove('10.6.0.2', PASSWORD)).statusCode).toBe(429);
    const row = await db.query('SELECT status FROM accounts WHERE id=$1', [id]);
    expect(row.rows[0].status).toBe('active');
    await app.close();
  });
});
