import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptEndpointKey,
  encryptEndpointKey,
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

  it('refuses a development envelope when a configured master key exists', () => {
    process.env.NODE_ENV = 'test';
    const legacy = encryptEndpointKey('opaque test fixture');
    process.env.OPERATOR_ENDPOINT_MASTER_KEY = `11`.repeat(32);
    expect(() => decryptEndpointKey(legacy)).toThrow(
      'Endpoint credential unavailable',
    );
  });
});
