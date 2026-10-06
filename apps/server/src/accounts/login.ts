import type { Pool } from 'pg';
import { hashPassword, verifyPassword } from './password.js';
import { createSession } from './sessions.js';
import { Limiter } from './throttle.js';

/** Bounds concurrent argon2 work from the login path; excess requests get BusyError. */
export const argonLimiter = new Limiter(4, 2000);

export const badCredentials = {
  code: 'BAD_CREDENTIALS',
  message: 'Email or password is incorrect.',
};
// An actual argon2id hash, used to spend the same verification work for absent accounts.
let dummyHash: Promise<string> | undefined;
export async function authenticate(db: Pool, email: string, password: string) {
  const result = await db.query(
    'SELECT id,email,password_hash,display_name,status,is_adult,age_checked_at FROM accounts WHERE email=$1',
    [email.trim().toLowerCase()],
  );
  const account = result.rows[0];
  const valid = await argonLimiter.run(async () => {
    const fallback = await (dummyHash ??= hashPassword(
      'dummy-password-never-used',
    ));
    return verifyPassword(account?.password_hash ?? fallback, password);
  });
  if (!account || !valid) return { kind: 'invalid' as const };
  if (account.status === 'pending_email') return { kind: 'pending' as const };
  if (account.status === 'deleting') return { kind: 'deleting' as const };
  if (account.status !== 'active') return { kind: 'invalid' as const };
  return { kind: 'ok' as const, account };
}
export async function login(
  db: Pool,
  email: string,
  password: string,
  label: string,
  now = new Date(),
) {
  const result = await authenticate(db, email, password);
  if (result.kind !== 'ok') return result;
  const token = await createSession(db, result.account.id, label, now);
  return { ...result, token };
}
