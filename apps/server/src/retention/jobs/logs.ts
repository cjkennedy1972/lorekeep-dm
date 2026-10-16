import type { JobContext } from '../types.js';

interface HoldScope {
  table: 'moderation_log' | 'x_card_log' | 'operator_endpoint_audit';
  kind: 'session' | 'account';
  column: 'session_id' | 'actor_id';
}

/** Deletes expired rows whose hold key has no legal hold; audits each held key once (ADR-017). */
async function purgeHoldAwareLogTable(
  ctx: JobContext,
  { table, kind, column }: HoldScope,
) {
  const { db, now } = ctx;
  const heldIds = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT t.${column}::text AS id FROM ${table} t
       JOIN legal_holds h ON h.kind=$1 AND h.item_id=t.${column}::text
       WHERE t.expires_at < $2`,
      [kind, now],
    )
  ).rows;
  for (const { id } of heldIds)
    await db.query(
      `INSERT INTO retention_audit(job,item_kind,item_id,action)
       SELECT 'logs',$1,$2,'skipped_legal_hold'
       WHERE NOT EXISTS (SELECT 1 FROM retention_audit
         WHERE job='logs' AND item_kind=$1 AND item_id=$2 AND action='skipped_legal_hold')`,
      [kind, id],
    );
  return db.query(
    `DELETE FROM ${table} t WHERE t.expires_at < $1
       AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind=$2 AND h.item_id=t.${column}::text)`,
    [now, kind],
  );
}

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
  const endpointAudit = await purgeHoldAwareLogTable(ctx, {
    table: 'operator_endpoint_audit',
    kind: 'account',
    column: 'actor_id',
  });
  const moderation = await purgeHoldAwareLogTable(ctx, {
    table: 'moderation_log',
    kind: 'session',
    column: 'session_id',
  });
  const xCards = await purgeHoldAwareLogTable(ctx, {
    table: 'x_card_log',
    kind: 'session',
    column: 'session_id',
  });
  const counts = {
    events: Number(events),
    emailTokens: tokens.rowCount ?? 0,
    authSessions: authSessions.rowCount ?? 0,
    wsTickets: tickets.rowCount ?? 0,
    operatorEndpointAudit: endpointAudit.rowCount ?? 0,
    moderationLog: moderation.rowCount ?? 0,
    xCardLog: xCards.rowCount ?? 0,
  };
  ctx.log({ job: 'logs', ...counts });
  return counts;
}
