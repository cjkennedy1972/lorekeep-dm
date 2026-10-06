import type { Pool } from 'pg';
import { hashPassword, verifyPassword } from './password.js';
import { createSession } from './sessions.js';

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
  const fallback = await (dummyHash ??= hashPassword(
    'dummy-password-never-used',
  ));
  const valid = await verifyPassword(
    account?.password_hash ?? fallback,
    password,
  );
  if (!account || !valid) return { kind: 'invalid' as const };
  if (account.status === 'pending_email') return { kind: 'pending' as const };
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
