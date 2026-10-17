import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  isRetryableStatus,
  readBoundedErrorBody,
  sanitizeHttpError,
  selectCases,
  shouldRetry,
} from '../scripts/redteam-live-diagnostics.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('retries only 429 and 5xx, and at most once', () => {
  for (const status of [429, 500, 502, 503, 599])
    assert.equal(isRetryableStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 422, 200])
    assert.equal(isRetryableStatus(status), false, String(status));
  assert.equal(shouldRetry({ status: 400, retryCount: 0 }), false);
  assert.equal(shouldRetry({ status: 429, retryCount: 0 }), true);
  assert.equal(shouldRetry({ status: 503, retryCount: 1 }), false);
});

test('keeps only whitelisted fields and hashes the message', () => {
  const body = JSON.stringify({
    error: {
      message: 'Invalid value for messages[0].content: secret prompt text',
      type: 'invalid_request_error',
      code: 'invalid_value',
      param: 'messages[0].content',
    },
  });
  const diagnostic = sanitizeHttpError({
    status: 400,
    body,
    requestId: 'req_abc-123',
  });
  assert.deepEqual(diagnostic, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_value',
    param: 'messages[0].content',
    requestId: 'req_abc-123',
    message: {
      sha256: sha256(JSON.parse(body).error.message),
      length: JSON.parse(body).error.message.length,
    },
  });
  assert.equal(JSON.stringify(diagnostic).includes('secret prompt'), false);
});

test('redacts the API key from any field and drops unsafe values', () => {
  const key = 'sk-test-key-0123456789';
  const body = JSON.stringify({
    error: {
      type: `bad ${key}`,
      code: `${key}`,
      param: 'messages[0] with spaces',
      message: `echo ${key}`,
    },
  });
  const diagnostic = sanitizeHttpError({
    status: 401,
    body,
    requestId: key,
    secrets: [key],
  });
  assert.equal(diagnostic.type, null);
  assert.equal(diagnostic.code, null);
  assert.equal(diagnostic.param, null);
  assert.equal(diagnostic.requestId, null);
  assert.equal(JSON.stringify(diagnostic).includes(key), false);
  assert.equal(diagnostic.message.length, `echo ${key}`.length);
});

test('bounds oversized and non-JSON bodies without leaking raw text', () => {
  const huge = JSON.stringify({ error: { type: 'x'.repeat(5000) } });
  const bounded = sanitizeHttpError({ status: 500, body: huge });
  assert.equal(bounded.type, null);

  const raw = '<html>upstream exploded with secret-echo</html>';
  const plain = sanitizeHttpError({ status: 502, body: raw, requestId: null });
  assert.deepEqual(plain, {
    status: 502,
    type: null,
    code: null,
    param: null,
    requestId: null,
    message: null,
  });

  const longMessage = 'm'.repeat(200_000);
  const truncatedBody = JSON.stringify({ error: { message: longMessage } });
  const big = sanitizeHttpError({ status: 500, body: truncatedBody });
  assert.equal(big.message, null);
});

test('reads no more than the diagnostic body bound', async () => {
  let cancelled = false;
  const response = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(80_000)));
      },
      cancel() {
        cancelled = true;
      },
    }),
  };
  const body = await readBoundedErrorBody(response);
  assert.equal(body.length, 64 * 1024);
  assert.equal(cancelled, true);
});

test('selects a single case by id and returns all cases when unset', () => {
  const cases = [{ id: 'xc-010' }, { id: 'xc-011' }];
  assert.deepEqual(selectCases(cases, 'xc-011'), [{ id: 'xc-011' }]);
  assert.deepEqual(selectCases(cases, 'xc-999'), []);
  assert.equal(selectCases(cases, null), cases);
});
