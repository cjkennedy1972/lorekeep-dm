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

  it('matches the host only, not the scheme, for WebSocket origins', () => {
    expect(validOrigin('https://game.example', 'game.example')).toBe(true);
    expect(validOrigin('http://game.example', 'game.example')).toBe(true);
    expect(validOrigin('ws://game.example', 'game.example')).toBe(false);
  });

  it('honors WS_ALLOWED_ORIGINS by full origin in addition to same host', () => {
    expect(
      validOrigin('http://web.example', 'api.example', 'https://web.example'),
    ).toBe(false);
  });
});
