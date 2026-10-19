import { test } from 'vitest';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import {
  assertNoSecretParts,
  assertPinnedHost,
  buildChatCompletionsUrl,
  canonicalEndpointBaseUrl,
} from './endpoint-pin.mjs';

test('rejects endpoint URLs carrying credentials, query, or fragment', () => {
  assert.doesNotThrow(() =>
    assertNoSecretParts(new URL('http://10.0.0.5:8080/v1')),
  );
  for (const raw of [
    'http://user:key@10.0.0.5:8080/v1',
    'http://10.0.0.5:8080/v1?api_key=secret',
    'http://10.0.0.5:8080/v1#secret',
  ]) {
    assert.throws(
      () => assertNoSecretParts(new URL(raw), raw),
      /must not contain/,
    );
  }
});

test('rejects empty query and fragment delimiters in the original endpoint', () => {
  for (const raw of ['http://10.0.0.5:8080/v1?', 'http://10.0.0.5:8080/v1#']) {
    assert.throws(
      () => assertNoSecretParts(new URL(raw), raw),
      /must not contain/,
    );
  }
});

test('builds the actual chat request URL from the validated endpoint', () => {
  const endpointUrl = new URL('http://10.0.0.5:8080/v1');
  const recordedBaseUrl = canonicalEndpointBaseUrl(endpointUrl);
  const requestUrl = buildChatCompletionsUrl(endpointUrl);

  assert.equal(requestUrl, `${recordedBaseUrl}/chat/completions`);
  assert.equal(new URL(requestUrl).pathname, '/v1/chat/completions');

  const endpointWithTrailingSlash = new URL('http://10.0.0.5:8080/v1/');
  assert.equal(
    buildChatCompletionsUrl(endpointWithTrailingSlash),
    `${canonicalEndpointBaseUrl(endpointWithTrailingSlash)}/chat/completions`,
  );
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
