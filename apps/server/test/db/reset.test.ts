import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  requestPasswordReset,
  confirmPasswordReset,
} from '../../src/accounts/reset.js';
import { MemoryEmailSender } from '../../src/email/sender.js';
import { hashPassword, verifyPassword } from '../../src/accounts/password.js';

it('resets once, expires, revokes sessions, and preserves pending status', async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const sender = new MemoryEmailSender();
  const id = randomUUID();
  const email = `${id}@example.test`;
  const oldPassword = 'old secure passphrase';
  const newPassword = 'new secure passphrase';
  try {
    await db.query(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,$3,'Player','active',true,now(),'v1',now())",
      [id, email, await hashPassword(oldPassword)],
    );
    await db.query(
      "INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES ($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
      ['session-' + id, id],
    );
    const known = await requestPasswordReset(db, sender, email);
    expect(await known.sent).toBeUndefined();
    expect(await requestPasswordReset(db, sender, 'absent-' + email)).toEqual(
      {},
    );
    const token = sender.messages[0]?.token ?? '';
    expect(token).toHaveLength(43);
    expect(
      (
        await db.query(
          'SELECT token_hash FROM email_tokens WHERE account_id=$1 AND kind=$2',
          [id, 'reset'],
        )
      ).rows[0].token_hash,
    ).not.toBe(token);
    expect(await confirmPasswordReset(db, token, newPassword)).toBe(true);
    expect(await confirmPasswordReset(db, token, newPassword)).toBe(false);
    const account = (
      await db.query('SELECT password_hash,status FROM accounts WHERE id=$1', [
        id,
      ])
    ).rows[0];
    expect(await verifyPassword(account.password_hash, oldPassword)).toBe(
      false,
    );
    expect(await verifyPassword(account.password_hash, newPassword)).toBe(true);
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM auth_sessions WHERE account_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    await requestPasswordReset(db, sender, email);
    expect(
      await confirmPasswordReset(
        db,
        sender.messages.at(-1)?.token ?? '',
        newPassword,
        new Date(Date.now() + 3600_001),
      ),
    ).toBe(false);
    await db.query("UPDATE accounts SET status='pending_email' WHERE id=$1", [
      id,
    ]);
    await requestPasswordReset(db, sender, email);
    expect(
      await confirmPasswordReset(
        db,
        sender.messages.at(-1)?.token ?? '',
        newPassword,
      ),
    ).toBe(true);
    expect(
      (await db.query('SELECT status FROM accounts WHERE id=$1', [id])).rows[0]
        .status,
    ).toBe('pending_email');
  } finally {
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
    await db.end();
  }
});
