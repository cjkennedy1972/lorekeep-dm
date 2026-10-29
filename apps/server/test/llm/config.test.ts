import { createHash, createHmac } from 'node:crypto';
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

  it('derives a v2 fingerprint that is not any legacy form of the key', () => {
    const shortKey = 'opaque-short-fixture';
    const masterKey = `22`.repeat(32);
    const fingerprint = endpointKeyFingerprint(shortKey, masterKey);
    expect(fingerprint).toMatch(/^v2:[0-9a-f]{12}$/);
    const legacySha = createHash('sha256')
      .update(shortKey)
      .digest('hex')
      .slice(0, 12);
    const legacyHmac = createHmac('sha256', Buffer.from(masterKey, 'hex'))
      .update(shortKey)
      .digest('hex')
      .slice(0, 12);
    expect(fingerprint.slice(3)).not.toBe(legacySha);
    expect(fingerprint.slice(3)).not.toBe(legacyHmac);
    expect(fingerprint).not.toContain(shortKey);
    expect(endpointKeyFingerprint(shortKey, masterKey)).toBe(fingerprint);
    expect(endpointKeyFingerprint(shortKey, `33`.repeat(32))).not.toBe(
      fingerprint,
    );
    expect(endpointKeyFingerprint('other-fixture', masterKey)).not.toBe(
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
