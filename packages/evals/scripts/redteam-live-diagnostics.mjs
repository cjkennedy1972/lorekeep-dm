import { createHash } from 'node:crypto';

const MAX_ERROR_BODY_CHARS = 64 * 1024;
const SAFE_FIELD = /^[A-Za-z0-9_.:[\]/-]{1,120}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function shouldRetry({ status, retryCount }) {
  return retryCount < 1 && isRetryableStatus(status);
}

export async function readBoundedErrorBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (totalBytes < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_CHARS - totalBytes;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeValue(value, pattern, secrets) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  if (secrets.some((secret) => secret && value.includes(secret))) return null;
  return value;
}

function parseErrorObject(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error && typeof parsed.error === 'object'
      ? parsed.error
      : {};
  } catch {
    return {};
  }
}

export function sanitizeHttpError({
  status,
  body = '',
  requestId = null,
  secrets = [],
}) {
  const error = parseErrorObject(body.slice(0, MAX_ERROR_BODY_CHARS));
  const message = typeof error.message === 'string' ? error.message : null;
  return {
    status,
    type: safeValue(error.type, SAFE_FIELD, secrets),
    code: safeValue(error.code, SAFE_FIELD, secrets),
    param: safeValue(error.param, SAFE_FIELD, secrets),
    requestId: safeValue(requestId, SAFE_REQUEST_ID, secrets),
    message:
      message === null
        ? null
        : {
            sha256: createHash('sha256').update(message).digest('hex'),
            length: message.length,
          },
  };
}

export function selectCases(cases, onlyCase) {
  if (!onlyCase) return cases;
  return cases.filter((c) => c.id === onlyCase);
}
