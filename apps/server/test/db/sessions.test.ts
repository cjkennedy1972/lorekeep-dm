import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { signup } from '../../src/accounts/signup.js';
import { verifyEmail } from '../../src/accounts/verify.js';
import { MemoryEmailSender } from '../../src/email/sender.js';
import {
  createSession,
  getSession,
  revokeSession,
} from '../../src/accounts/sessions.js';
import { login } from '../../src/accounts/login.js';
const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => db.end());
describe('persistent sessions', () => {
  it('slides, caps, and revokes immediately', async () => {
    const email = `${randomUUID()}@example.test`;
    const sender = new MemoryEmailSender();
    await signup(
      db,
      sender,
      {
        email,
        password: 'unique-password-123',
        displayName: 'Player',
        birthdate: '1990-01-01',
        termsVersion: 'v1',
      },
      { cookieSecret: 'test' },
    );
    const id = (
      await db.query('SELECT id FROM accounts WHERE email=$1', [email])
    ).rows[0].id;
    try {
      expect((await login(db, email, 'unique-password-123', 'test')).kind).toBe(
        'pending',
      );
      expect(
        await verifyEmail(db, sender.messages[0]!.token, 'unique-password-123'),
      ).toBe(true);
      const result = await login(db, email, 'unique-password-123', 'test');
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') throw new Error('login failed');
      const before = (
        await db.query(
          'SELECT expires_at FROM auth_sessions WHERE account_id=$1',
          [id],
        )
      ).rows[0].expires_at;
      expect(
        await getSession(db, result.token, new Date(Date.now() + 86_400_000)),
      ).toBeTruthy();
      const after = (
        await db.query(
          'SELECT expires_at FROM auth_sessions WHERE account_id=$1',
          [id],
        )
      ).rows[0].expires_at;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      await revokeSession(db, result.token);
      expect(await getSession(db, result.token)).toBeUndefined();
      const old = await createSession(
        db,
        id,
        'old',
        new Date(Date.now() - 91 * 86_400_000),
      );
      expect(await getSession(db, old)).toBeUndefined();
    } finally {
      await db.query('DELETE FROM accounts WHERE id=$1', [id]);
    }
  });
});
