import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptEndpointKey,
  encryptEndpointKey,
  endpointKeyFingerprint,
} from '../../src/llm/config.js';

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.OPERATOR_ENDPOINT_MASTER_KEY;
});

describe('endpoint encryption environment policy', () => {
  it('uses the fallback only in explicit development or test environments', () => {
    process.env.NODE_ENV = 'development';
    const envelope = encryptEndpointKey('opaque test fixture');
    expect(decryptEndpointKey(envelope)).toBe('opaque test fixture');
    process.env.NODE_ENV = 'production';
    expect(() => decryptEndpointKey(envelope)).toThrow(
      'Endpoint credential unavailable',
    );
    expect(() => encryptEndpointKey('opaque test fixture')).toThrow(
      'Endpoint encryption key unavailable',
    );
  });

  it('keys the endpoint key fingerprint so it is not a plain sha256 prefix', () => {
    const shortKey = 'opaque-short-fixture';
    const fingerprint = endpointKeyFingerprint(shortKey, `22`.repeat(32));
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).not.toBe(
      createHash('sha256').update(shortKey).digest('hex').slice(0, 12),
    );
    expect(endpointKeyFingerprint(shortKey, `22`.repeat(32))).toBe(fingerprint);
    expect(endpointKeyFingerprint(shortKey, `33`.repeat(32))).not.toBe(
      fingerprint,
    );
  });

  it('refuses a development envelope when a configured master key exists', () => {
    process.env.NODE_ENV = 'test';
    const legacy = encryptEndpointKey('opaque test fixture');
    process.env.OPERATOR_ENDPOINT_MASTER_KEY = `11`.repeat(32);
    expect(() => decryptEndpointKey(legacy)).toThrow(
      'Endpoint credential unavailable',
    );
  });
});
