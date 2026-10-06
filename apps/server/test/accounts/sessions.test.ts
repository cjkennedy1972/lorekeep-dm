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
  it('production accepts only __Host-sid; dev also accepts sid', () => {
    const t = 'b'.repeat(43);
    expect(tokenFromCookie(`sid=${t}`, true)).toBeUndefined();
    expect(tokenFromCookie(`__Host-sid=${t}`, true)).toBe(t);
    expect(tokenFromCookie(`sid=${t}`, false)).toBe(t);
    // injected sid cannot shadow the real cookie in production
    expect(
      tokenFromCookie(`sid=${'c'.repeat(43)}; __Host-sid=${t}`, true),
    ).toBe(t);
  });
  it('treats duplicate session cookies as unauthenticated', () => {
    const [a, b] = ['d'.repeat(43), 'e'.repeat(43)];
    expect(
      tokenFromCookie(`__Host-sid=${a}; __Host-sid=${b}`, true),
    ).toBeUndefined();
    expect(tokenFromCookie(`sid=${a}; sid=${b}`, false)).toBeUndefined();
  });
});
