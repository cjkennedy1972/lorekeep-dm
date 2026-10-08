import type { JobContext } from '../types.js';

/** Log-class rows and expired tokens/sessions/tickets, including endpoint audit. */
export async function purgeLogs(ctx: JobContext) {
  const { db, now } = ctx;
  const events = (
    await db.query<{ n: string }>('SELECT purge_expired_events($1) AS n', [now])
  ).rows[0]!.n;
  const tokens = await db.query(
    'DELETE FROM email_tokens WHERE expires_at < $1',
    [now],
  );
  const authSessions = await db.query(
    'DELETE FROM auth_sessions WHERE expires_at < $1 OR absolute_expires_at < $1',
    [now],
  );
  const tickets = await db.query(
    'DELETE FROM ws_tickets WHERE expires_at < $1',
    [now],
  );
  const endpointAudit = await db.query(
    'DELETE FROM operator_endpoint_audit WHERE expires_at < $1',
    [now],
  );
  const counts = {
    events: Number(events),
    emailTokens: tokens.rowCount ?? 0,
    authSessions: authSessions.rowCount ?? 0,
    wsTickets: tickets.rowCount ?? 0,
    operatorEndpointAudit: endpointAudit.rowCount ?? 0,
  };
  ctx.log({ job: 'logs', ...counts });
  return counts;
}
