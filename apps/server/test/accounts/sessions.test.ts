import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  sessionCookie,
  tokenFromCookie,
} from '../../src/accounts/sessions.js';
const savedNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe('sessions', () => {
  it('sets a host-only httpOnly secure same-site cookie', () => {
    process.env.NODE_ENV = 'production';
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

describe('session cookie secure default', () => {
  it('is Secure and __Host- prefixed unless NODE_ENV is development or test', () => {
    const t = 'f'.repeat(43);
    for (const env of [undefined, 'production', 'prodution']) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      expect(sessionCookie(t)).toContain('__Host-sid=' + t);
      expect(sessionCookie(t)).toContain('; Secure');
      expect(clearSessionCookie()).toContain('; Secure');
      expect(tokenFromCookie(`sid=${t}`)).toBeUndefined();
    }
  });
  it('relaxes to plain sid without Secure only in development or test', () => {
    const t = 'g'.repeat(43);
    for (const env of ['development', 'test']) {
      process.env.NODE_ENV = env;
      expect(sessionCookie(t)).toContain('sid=' + t);
      expect(sessionCookie(t)).not.toContain('Secure');
      expect(tokenFromCookie(`sid=${t}`)).toBe(t);
    }
  });
});
