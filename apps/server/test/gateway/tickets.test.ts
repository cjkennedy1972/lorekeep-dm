import { describe, expect, it } from 'vitest';
import { validOrigin } from '../../src/gateway/tickets.js';
describe('origin policy', () => {
  it('allows same origin or configured origins only', () => {
    expect(validOrigin('http://localhost:8787', 'localhost:8787')).toBe(true);
    expect(
      validOrigin('https://web.example', 'api.example', 'https://web.example'),
    ).toBe(true);
    expect(validOrigin('https://evil.example', 'api.example')).toBe(false);
    expect(validOrigin(undefined, 'api.example')).toBe(false);
  });
});
