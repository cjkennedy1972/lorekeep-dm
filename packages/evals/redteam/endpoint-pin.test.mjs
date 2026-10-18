import { test } from 'vitest';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import { assertNoSecretParts, assertPinnedHost } from './endpoint-pin.mjs';

test('rejects endpoint URLs carrying credentials, query, or fragment', () => {
  assert.doesNotThrow(() =>
    assertNoSecretParts(new URL('http://10.0.0.5:8080/v1')),
  );
  for (const raw of [
    'http://user:key@10.0.0.5:8080/v1',
    'http://10.0.0.5:8080/v1?api_key=secret',
    'http://10.0.0.5:8080/v1#secret',
  ]) {
    assert.throws(() => assertNoSecretParts(new URL(raw)), /must not contain/);
  }
});

test('accepts the expected host', () => {
  assert.doesNotThrow(() => assertPinnedHost('10.0.0.5:8080', '10.0.0.5:8080'));
});

test('rejects a mismatched host', () => {
  assert.throws(
    () => assertPinnedHost('evil.example:8080', '10.0.0.5:8080'),
    /does not match REDTEAM_EXPECTED_HOST/,
  );
});

test('requires an expected host', () => {
  assert.throws(() => assertPinnedHost('10.0.0.5:8080', undefined), /required/);
});
