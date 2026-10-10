import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { hashToken } from '../../src/accounts/signup.js';
import { verifyEmail } from '../../src/accounts/verify.js';

const hashPassword = vi.hoisted(() => vi.fn(async () => '$argon2id$stub'));
vi.mock('../../src/accounts/password.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/accounts/password.js')>()),
  hashPassword,
}));

it('hashes verification tokens deterministically without retaining raw token', () => {
  const token = 'a'.repeat(43);
  expect(hashToken(token)).toHaveLength(64);
  expect(hashToken(token)).not.toContain(token);
});

const token = 'a'.repeat(43);

function fakePool(tokenRows: number, accountRows: number) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.trim().split(/\s+/)[0]!);
    if (sql.includes('UPDATE email_tokens')) {
      return {
        rowCount: tokenRows,
        rows: tokenRows ? [{ account_id: 'acct-1' }] : [],
      };
    }
    if (sql.includes('UPDATE accounts')) {
      return { rowCount: accountRows, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  const db = {
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  return { db, statements };
}

describe('verifyEmail', () => {
  it('does not hash the password when the token matches no live row', async () => {
    hashPassword.mockClear();
    const { db, statements } = fakePool(0, 0);
    expect(await verifyEmail(db, token, 'new-password-123')).toBe(false);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('returns false and rolls back when the account is no longer pending_email', async () => {
    hashPassword.mockClear();
    const { db, statements } = fakePool(1, 0);
    expect(await verifyEmail(db, token, 'new-password-123')).toBe(false);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('commits when the token and account both match', async () => {
    hashPassword.mockClear();
    const { db, statements } = fakePool(1, 1);
    expect(await verifyEmail(db, token, 'new-password-123')).toBe(true);
    expect(hashPassword).toHaveBeenCalledTimes(1);
    expect(statements).toContain('COMMIT');
  });
});
