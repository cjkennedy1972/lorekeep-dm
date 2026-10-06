import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  changePassword,
  confirmPasswordReset,
  requestPasswordReset,
} from '../../src/accounts/reset.js';
import { MemoryEmailSender } from '../../src/email/sender.js';
import { hashToken } from '../../src/accounts/signup.js';
import { hashPassword } from '../../src/accounts/password.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const ids: string[] = [];
async function account() {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.query(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,'x','P','active',true,now(),'v1',now())",
    [id, email],
  );
  ids.push(id);
  return { id, email };
}
const unused = async (id: string) =>
  (
    await db.query(
      "SELECT count(*)::int n FROM email_tokens WHERE account_id=$1 AND kind='reset' AND used_at IS NULL",
      [id],
    )
  ).rows[0].n as number;
afterAll(async () => {
  await db.query('DELETE FROM accounts WHERE id=ANY($1)', [ids]);
  await db.end();
});

describe('reset token invalidation', () => {
  it('a stale token is dead after recovery with another link', async () => {
    const { id, email } = await account();
    const sender = new MemoryEmailSender();
    await requestPasswordReset(db, sender, email);
    const first = sender.messages[0]!.token;
    // Attacker holds `first`; a newer request supersedes it.
    await requestPasswordReset(db, sender, email);
    const second = sender.messages[1]!.token;
    expect(await unused(id)).toBe(1);
    expect(await confirmPasswordReset(db, first, 'attacker passphrase 1')).toBe(
      false,
    );
    expect(await confirmPasswordReset(db, second, 'victim passphrase 1')).toBe(
      true,
    );
    expect(await unused(id)).toBe(0);
  });
  it('successful reset retires every other outstanding token', async () => {
    const { id } = await account();
    const [one, two] = ['m', 'n'].map((c) => c.repeat(43));
    for (const t of [one!, two!])
      await db.query(
        "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'reset',now()+interval '1 hour')",
        [hashToken(t), id],
      );
    expect(await confirmPasswordReset(db, one!, 'victim passphrase 2')).toBe(
      true,
    );
    expect(await unused(id)).toBe(0);
    expect(await confirmPasswordReset(db, two!, 'attacker passphrase 2')).toBe(
      false,
    );
  });
  it('authenticated password change retires reset tokens and other sessions', async () => {
    const { id, email } = await account();
    const sender = new MemoryEmailSender();
    await requestPasswordReset(db, sender, email);
    const token = sender.messages[0]!.token;
    for (const h of ['keep-' + id, 'drop-' + id])
      await db.query(
        "INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES ($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
        [h, id],
      );
    await changePassword(
      db,
      id,
      'keep-' + id,
      await hashPassword('changed passphrase 1'),
    );
    expect(await unused(id)).toBe(0);
    expect(await confirmPasswordReset(db, token, 'attacker passphrase 4')).toBe(
      false,
    );
    const left = await db.query(
      'SELECT token_hash FROM auth_sessions WHERE account_id=$1',
      [id],
    );
    expect(left.rows.map((r) => r.token_hash)).toEqual(['keep-' + id]);
  });
  it('concurrent resets with different links serialize: exactly one wins', async () => {
    const { id } = await account();
    const tokens = ['a', 'b'].map((c) => c.repeat(43));
    for (const t of tokens)
      await db.query(
        "INSERT INTO email_tokens(token_hash,account_id,kind,expires_at) VALUES ($1,$2,'reset',now()+interval '1 hour')",
        [hashToken(t), id],
      );
    const results = await Promise.all([
      confirmPasswordReset(db, tokens[0]!, 'concurrent passphrase 1'),
      confirmPasswordReset(db, tokens[1]!, 'concurrent passphrase 2'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await unused(id)).toBe(0);
  });
});
