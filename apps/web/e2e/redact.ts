// Invite codes travel in /join/<code> and /api/invites/<code>/join, and tickets and tokens travel in
// query strings. Use these wherever a URL, or an error that may contain one, is printed.
// The party copy in apps/web/e2e-party/redact.ts must stay byte-identical to this file.

// Path form, case-insensitive, with literal or percent-encoded slashes (returnTo values are encoded).
const INVITE_PATH =
  /((?:\/|%2F)(?:join|api(?:\/|%2F)invites)(?:\/|%2F))[^/?#\s'"`%]+/gi;
const SECRET_QUERY = /([?&](?:ticket|token|invite)=)[^&#\s'"`]+/gi;
const RETURN_TO = /([?&]returnTo=)([^&#\s'"`]+)/gi;
// A standalone 22-character base64url run (an invite code's shape). A run inside a longer token, such
// as a UUID room id, is not a whole match and is left alone. A run glued to other token characters
// (room_<code>) is not matched; the invite-bearing paths and queries above cover those sinks.
const BARE_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g;

/** Replaces invite codes, secret query values and bare invite-shaped tokens inside any text. */
export function redactInviteUrls(text: string): string {
  return text
    .replace(INVITE_PATH, '$1[REDACTED]')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(RETURN_TO, (match, key: string, value: string) =>
      /join|invites/i.test(value) ? `${key}[REDACTED]` : match,
    )
    .replace(BARE_TOKEN, '[REDACTED]');
}

function hasUrl(text: string): boolean {
  return /[a-z][a-z0-9+.-]*:\/\/|\/join\/|\/api\//i.test(text);
}

// Copies an error with its prototype (so Playwright's TimeoutError still matches instanceof), name,
// stack and cause. Message and stack are redacted; a cause that carries a URL is dropped.
function redactValue(value: unknown, depth: number): unknown {
  return value instanceof Error && depth < 3
    ? redactError(value, depth + 1)
    : redactInviteUrls(String(value));
}

function redactError(error: Error, depth = 0): Error {
  const message = redactInviteUrls(error.message);
  const errors = (error as AggregateError).errors;
  const redacted = Array.isArray(errors)
    ? new AggregateError(
        errors.map((item) => redactValue(item, depth)),
        message,
      )
    : new Error(message);
  Object.setPrototypeOf(redacted, Object.getPrototypeOf(error));
  redacted.name = error.name;
  if (error.stack) redacted.stack = redactInviteUrls(error.stack);
  const cause: unknown = error.cause;
  if (cause !== undefined) {
    const causeText =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    if (!hasUrl(causeText) && depth < 3) {
      redacted.cause =
        cause instanceof Error
          ? redactError(cause, depth + 1)
          : redactInviteUrls(String(cause));
    }
  }
  return redacted;
}

/** Rethrows a Playwright error (goto, expect) with invite codes removed, for use in `.catch`. */
export function rethrowRedacted(error: unknown): never {
  if (error instanceof Error) throw redactError(error);
  throw new Error(redactInviteUrls(String(error)));
}

/**
 * The pathname only, with any invite redacted and the query replaced by a marker. A regex anchored on
 * the query (as in toHaveURL) fails on the marker exactly as it would on the real query.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${redactInviteUrls(parsed.pathname)}${parsed.search ? '?[REDACTED]' : ''}`;
  } catch {
    return '(unparseable url)';
  }
}
