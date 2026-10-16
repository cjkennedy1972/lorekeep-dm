import type { JobContext } from '../types.js';

type HoldKey = { kind: 'session' | 'account'; column: string };
interface HoldAwareTable {
  table: 'moderation_log' | 'x_card_log' | 'operator_endpoint_audit';
  keys: HoldKey[];
}

const HOLD_AWARE_TABLES: HoldAwareTable[] = [
  {
    table: 'operator_endpoint_audit',
    keys: [{ kind: 'account', column: 'actor_id' }],
  },
  {
    table: 'moderation_log',
    keys: [
      { kind: 'session', column: 'session_id' },
      { kind: 'account', column: 'account_id' },
    ],
  },
  { table: 'x_card_log', keys: [{ kind: 'session', column: 'session_id' }] },
];

/** Deletes expired rows unless any of their hold keys is under legal hold; audits each held key once (ADR-017). */
async function purgeHoldAwareLogTable(
  ctx: JobContext,
  { table, keys }: HoldAwareTable,
) {
  const { db, now } = ctx;
  for (const { kind, column } of keys) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT DISTINCT t.${column}::text AS id FROM ${table} t
       JOIN legal_holds h ON h.kind=$1 AND h.item_id=t.${column}::text
       WHERE t.expires_at < $2`,
      [kind, now],
    );
    for (const { id } of rows)
      await db.query(
        `INSERT INTO retention_audit(job,item_kind,item_id,action)
         SELECT 'logs',$1,$2,'skipped_legal_hold'
         WHERE NOT EXISTS (SELECT 1 FROM retention_audit
           WHERE job='logs' AND item_kind=$1 AND item_id=$2 AND action='skipped_legal_hold')`,
        [kind, id],
      );
  }
  const heldBy = keys
    .map(
      ({ kind, column }) =>
        `EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='${kind}' AND h.item_id=t.${column}::text)`,
    )
    .join(' OR ');
  return db.query(
    `DELETE FROM ${table} t WHERE t.expires_at < $1 AND NOT (${heldBy})`,
    [now],
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
  const endpointAudit = await purgeHoldAwareLogTable(
    ctx,
    HOLD_AWARE_TABLES[0]!,
  );
  const moderation = await purgeHoldAwareLogTable(ctx, HOLD_AWARE_TABLES[1]!);
  const xCards = await purgeHoldAwareLogTable(ctx, HOLD_AWARE_TABLES[2]!);
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
