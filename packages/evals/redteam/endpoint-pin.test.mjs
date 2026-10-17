import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assertPinnedHost } from './endpoint-pin.mjs';

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
