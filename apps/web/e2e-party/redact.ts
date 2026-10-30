// Invite codes travel in /join/<code> and must never reach the CI log, traces, or reports. Tickets and
// tokens travel in query strings. Use these wherever a URL or an error that may contain one is printed.

const INVITE_PATH = /\/join\/[^/?#\s'"`]+/g;
const SECRET_QUERY = /([?&](?:ticket|token|invite)=)[^&#\s'"`]+/gi;

/** Replaces invite codes and secret query values inside any text (error messages, call logs, JSON). */
export function redactInviteUrls(text: string): string {
  return text
    .replace(INVITE_PATH, '/join/[REDACTED]')
    .replace(SECRET_QUERY, '$1[REDACTED]');
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
