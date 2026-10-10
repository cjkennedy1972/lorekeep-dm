import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { hashToken } from './signup.js';
const DAY = 86_400_000;
export const COOKIE_NAME = '__Host-sid';
export function isDevelopmentOrTest(): boolean {
  return ['development', 'test'].includes(process.env.NODE_ENV ?? '');
}

// ponytail: static flag, not request protocol, so it holds behind a TLS proxy regardless of TRUST_PROXY
export function secureCookies(): boolean {
  return !isDevelopmentOrTest();
}

export function sessionCookie(token: string, secure = secureCookies()): string {
  return `${secure ? COOKIE_NAME : 'sid'}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
}
export function clearSessionCookie(secure = secureCookies()): string {
  return `${secure ? COOKIE_NAME : 'sid'}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
/** Production accepts only `__Host-sid`; plain `sid` is a dev/test fallback. More than one session cookie is ambiguous (injection) and means unauthenticated. */
export function tokenFromCookie(
  header?: string,
  production = secureCookies(),
): string | undefined {
  const pairs = (header ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter(
      (v) =>
        v.startsWith(`${COOKIE_NAME}=`) ||
        (!production && v.startsWith('sid=')),
    );
  if (pairs.length !== 1) return undefined;
  const pair = pairs[0]!;
  const token = pair.slice(pair.indexOf('=') + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export async function createSession(
  db: Pool,
  accountId: string,
  label: string,
  now = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at,ua_label) VALUES($1,$2,$3,$4,$5,$6)',
    [
      hashToken(token),
      accountId,
      new Date(now.getTime() + 30 * DAY),
      new Date(now.getTime() + 90 * DAY),
      now,
      label,
    ],
  );
  return token;
}
export async function getSession(db: Pool, token: string, now = new Date()) {
  const result = await db.query(
    `UPDATE auth_sessions s SET last_active_at=$2, expires_at=LEAST(s.absolute_expires_at,$2::timestamptz + interval '30 days') FROM accounts a WHERE s.token_hash=$1 AND a.id=s.account_id AND a.status='active' AND s.expires_at>$2 AND s.absolute_expires_at>$2 RETURNING s.account_id,s.token_hash`,
    [hashToken(token), now],
  );
  return result.rows[0] as
    | { account_id: string; token_hash: string }
    | undefined;
}
export async function revokeSession(db: Pool, token: string): Promise<void> {
  await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
    hashToken(token),
  ]);
}
export function deviceLabel(ua: string): string {
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg/.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : 'unknown OS';
  return `${browser} on ${os}`;
}
