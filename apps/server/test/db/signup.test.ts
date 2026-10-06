import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEmailSender } from '../../src/email/sender.js';
import { signup } from '../../src/accounts/signup.js';
import { verifyEmail } from '../../src/accounts/verify.js';
const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => db.end());
const input = (email: string, birthdate = '1990-01-01') => ({
  email,
  birthdate,
  password: 'a-unique-password-123',
  displayName: 'Player',
  termsVersion: 'v1',
});
describe('signup persistence', () => {
  it('discards birthdate, refuses minors, masks duplicates, and consumes token once', async () => {
    const email = `${randomUUID()}@example.test`;
    const sender = new MemoryEmailSender();
    const minor = await signup(db, sender, input(email, '2015-01-01'), {
      cookieSecret: 'test-secret',
    });
    expect(minor.retryBlockCookie).toContain('age_retry_block');
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM accounts WHERE email=$1',
          [email],
        )
      ).rows[0].n,
    ).toBe(0);
    const adult = await signup(db, sender, input(email), {
      cookieSecret: 'test-secret',
    });
    const duplicate = await signup(db, sender, input(email), {
      cookieSecret: 'test-secret',
    });
    expect(adult.response).toEqual(duplicate.response);
    expect(sender.messages).toHaveLength(1);
    const account = (
      await db.query(
        'SELECT id,status,is_adult,age_checked_at,password_hash FROM accounts WHERE email=$1',
        [email],
      )
    ).rows[0];
    expect(account.status).toBe('pending_email');
    expect(account.is_adult).toBe(true);
    expect(account.age_checked_at).toBeTruthy();
    expect(account.password_hash).toMatch(/^\$argon2id\$/);
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='accounts' AND column_name ~* '(birthdate|dob)'`,
    );
    expect(columns.rows).toEqual([]);
    const token = sender.messages[0]!.token;
    expect(await verifyEmail(db, token)).toBe(true);
    expect(await verifyEmail(db, token)).toBe(false);
    await db.query(
      "UPDATE email_tokens SET used_at=NULL, expires_at=now()-interval '1 second' WHERE account_id=$1",
      [account.id],
    );
    expect(await verifyEmail(db, token)).toBe(false);
    expect(
      (await db.query('SELECT status FROM accounts WHERE id=$1', [account.id]))
        .rows[0].status,
    ).toBe('active');
    await db.query('DELETE FROM accounts WHERE id=$1', [account.id]);
  });
});
