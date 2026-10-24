import { timingSafeEqual } from 'node:crypto';
import { tokenFromCookie } from '../accounts/sessions.js';
import { hashToken } from '../accounts/signup.js';

export function ticketCookieMatches(
  cookieHeader: string | undefined,
  authTokenHash: string,
): boolean {
  const token = tokenFromCookie(cookieHeader);
  if (!token) return false;
  const cookieHash = hashToken(token);
  return (
    cookieHash.length === authTokenHash.length &&
    timingSafeEqual(Buffer.from(cookieHash), Buffer.from(authTokenHash))
  );
}
