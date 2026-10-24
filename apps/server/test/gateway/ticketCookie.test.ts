import { describe, expect, it } from 'vitest';
import { hashToken } from '../../src/accounts/signup.js';
import { ticketCookieMatches } from '../../src/gateway/ticketCookie.js';

const token = 'a'.repeat(43);

describe('ticket upgrade cookie binding', () => {
  it('accepts only the cookie matching the ticket auth hash', () => {
    expect(ticketCookieMatches(`sid=${token}`, hashToken(token))).toBe(true);
    expect(ticketCookieMatches(`sid=${'b'.repeat(43)}`, hashToken(token))).toBe(
      false,
    );
    expect(ticketCookieMatches(undefined, hashToken(token))).toBe(false);
    expect(
      ticketCookieMatches(`sid=${token}; sid=${token}`, hashToken(token)),
    ).toBe(false);
  });
});
