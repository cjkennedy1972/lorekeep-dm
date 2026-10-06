import { createHmac, timingSafeEqual } from 'node:crypto';
import { checkAdult } from './age.js';

export const RETRY_BLOCK_COOKIE = 'age_retry_block';
export const RETRY_BLOCK_TTL_SECONDS = 15 * 60;
const signature = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** Returns a signed, HTTP-only cookie containing only an expiration time. */
export function createRetryBlockCookie(
  secret: string,
  now: Date = new Date(),
): string {
  if (!secret || !Number.isFinite(now.getTime()))
    throw new RangeError('Invalid cookie configuration');
  const payload = String(
    Math.floor(now.getTime() / 1000) + RETRY_BLOCK_TTL_SECONDS,
  );
  return `${RETRY_BLOCK_COOKIE}=${payload}.${signature(payload, secret)}; Max-Age=${RETRY_BLOCK_TTL_SECONDS}; Path=/api/signup; HttpOnly; Secure; SameSite=Lax`;
}

/** Call before evaluating a new birthdate. Returns false for malformed, forged, or expired cookies. */
export function isRetryBlocked(
  cookieHeader: string | undefined,
  secret: string,
  now: Date = new Date(),
): boolean {
  if (!secret || !Number.isFinite(now.getTime()))
    throw new RangeError('Invalid cookie configuration');
  const value = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${RETRY_BLOCK_COOKIE}=`))
    ?.slice(RETRY_BLOCK_COOKIE.length + 1);
  if (!value) return false;
  const match = /^(\d{1,13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const [, payload, mac] = match;
  if (!payload || !mac) return false;
  const expiry = Number(payload);
  const current = Math.floor(now.getTime() / 1000);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= current ||
    expiry > current + RETRY_BLOCK_TTL_SECONDS
  )
    return false;
  const expected = Buffer.from(signature(payload, secret));
  const received = Buffer.from(mac);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** No birthdate is returned or retained on refusal. */
export function attestAdult(
  birthdate: string,
  cookieHeader: string | undefined,
  secret: string,
  now: Date = new Date(),
):
  | { allowed: true; isAdult: true; ageCheckedAt: string }
  | { allowed: false; retryBlockCookie?: string } {
  if (isRetryBlocked(cookieHeader, secret, now)) return { allowed: false };

  if (!checkAdult(birthdate, now))
    return {
      allowed: false as const,
      retryBlockCookie: createRetryBlockCookie(secret, now),
    };
  return {
    allowed: true as const,
    isAdult: true as const,
    ageCheckedAt: now.toISOString(),
  };
}
