import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  sessionCookie,
  tokenFromCookie,
} from '../../src/accounts/sessions.js';
describe('sessions', () => {
  it('sets a host-only httpOnly secure same-site cookie', () => {
    const token = 'a'.repeat(43);
    expect(sessionCookie(token)).toContain('__Host-sid=' + token);
    expect(sessionCookie(token)).toContain('HttpOnly; SameSite=Lax');
    expect(sessionCookie(token)).toContain('; Secure');
    expect(tokenFromCookie('x=1; ' + sessionCookie(token))).toBe(token);
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
