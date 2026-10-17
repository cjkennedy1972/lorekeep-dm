import type { Pool } from 'pg';
import { liveDmAllowed } from '../llm/liveDmGate.js';
import { computeContentTier, type ContentTier, type HostCap } from './tier.js';
import { currentMemberEventsSql } from '../room/membership.js';

type Queryable = Pick<Pool, 'query'>;
// One seat may save at most 20 lines and 20 veils; rooms cap at six seats.
const MAX_SESSION_BOUNDARIES = 6 * (20 + 20);

/**
 * Live tier for the session plus the tier last committed to sessions.content_tier. The host's
 * cap (sessions.host_tier_cap, NULL = none) is applied here; computeContentTier fails it closed.
 */
export async function loadContentTierState(
  db: Queryable,
  sessionId: string,
  endpointAllowsMature: boolean,
): Promise<{ tier: ContentTier; stored: ContentTier }> {
  const { rows } = await db.query<{
    content_tier: ContentTier;
    moderation_verified: boolean;
    host_tier_cap: HostCap | null;
    endpoint_allows_mature: boolean;
  }>(
    'SELECT content_tier, moderation_verified, host_tier_cap, endpoint_allows_mature FROM sessions WHERE id=$1',
    [sessionId],
  );
  const session = rows[0];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const tier = computeContentTier({
    seatedMatureOptOuts: await loadSeatedMatureOptOuts(db, sessionId),
    moderationVerified: session.moderation_verified,
    endpointAllowsMature:
      endpointAllowsMature && session.endpoint_allows_mature,
    hostCap: session.host_tier_cap ?? undefined,
  });
  return { tier, stored: session.content_tier };
}

/**
 * Live mature block for every account currently seated (not revoked) in the session: true when the
 * account opted out, is not an adult, or is missing or not active (e.g. deleting). The seat's
 * join-time snapshot is not used.
 */
export async function loadSeatedMatureOptOuts(
  db: Queryable,
  sessionId: string,
): Promise<boolean[]> {
  const { rows } = await db.query<{ opted_out: boolean }>(
    `SELECT (a.id IS NULL OR a.status <> 'active' OR a.is_adult IS NOT TRUE OR a.mature_opt_out IS NOT FALSE) AS opted_out
       FROM (SELECT DISTINCT payload->>'accountId' AS account_id FROM (${currentMemberEventsSql('$1')}) current_seat
              WHERE payload->>'accountId' IS NOT NULL) seated
       LEFT JOIN accounts a ON a.id = CASE
         WHEN seated.account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN seated.account_id::uuid ELSE NULL END`,
    [sessionId],
  );
  return rows.map((row) => row.opted_out);
}

/**
 * Whether a host may raise the table to mature now: the endpoint allows it, moderation is verified,
 * every seated account is an adult without an opt-out (ADR-016), and, while the live DM allowlist
 * is on, every seated account may take live turns.
 */
export async function matureAllowed(
  db: Queryable,
  sessionId: string,
  endpointAllowsMature: boolean,
  liveDmAllowlistOnly: boolean,
): Promise<boolean> {
  const { rows } = await db.query<{
    moderation_verified: boolean;
    endpoint_allows_mature: boolean;
  }>(
    'SELECT moderation_verified, endpoint_allows_mature FROM sessions WHERE id=$1',
    [sessionId],
  );
  const session = rows[0];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const tier = computeContentTier({
    seatedMatureOptOuts: await loadSeatedMatureOptOuts(db, sessionId),
    moderationVerified: session.moderation_verified,
    endpointAllowsMature:
      endpointAllowsMature && session.endpoint_allows_mature,
  });
  if (tier !== 'mature') return false;
  if (!liveDmAllowlistOnly) return true;
  const seated = await db.query<{ account_id: string }>(
    `SELECT DISTINCT payload->>'accountId' AS account_id FROM (${currentMemberEventsSql('$1')}) current_seat
      WHERE payload->>'accountId' IS NOT NULL`,
    [sessionId],
  );
  for (const { account_id } of seated.rows)
    if (!(await liveDmAllowed(db, account_id, true, undefined))) return false;
  return true;
}

/**
 * Union personal lines and veils for every account currently seated (not revoked) at this shared table.
 * The lists stay account-private in storage; only the unattributed union is used by
 * narration and moderation. Missing/deleted accounts contribute no free-text data.
 */
export async function loadSeatedContentBoundaries(
  db: Queryable,
  sessionId: string,
): Promise<{ lines: string[]; veils: string[] }> {
  const { rows } = await db.query<{
    lines: string[];
    veils: string[];
    boundary_count: number;
  }>(
    `WITH seated AS (
       SELECT DISTINCT payload->>'accountId' AS account_id
         FROM (${currentMemberEventsSql('$1')}) current_seat
        WHERE payload->>'accountId' IS NOT NULL
     ), boundary_rows AS (
       SELECT DISTINCT 'line' AS kind, boundary
         FROM seated s JOIN accounts a ON a.id = CASE
           WHEN s.account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN s.account_id::uuid ELSE NULL END
         CROSS JOIN LATERAL unnest(a.content_lines) AS boundary
       UNION
       SELECT DISTINCT 'veil' AS kind, boundary
         FROM seated s JOIN accounts a ON a.id = CASE
           WHEN s.account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN s.account_id::uuid ELSE NULL END
         CROSS JOIN LATERAL unnest(a.content_veils) AS boundary
     )
     SELECT
       COALESCE((
         SELECT array_agg(boundary ORDER BY boundary) FROM (
           SELECT boundary FROM boundary_rows WHERE kind='line'
           ORDER BY boundary LIMIT ${MAX_SESSION_BOUNDARIES + 1}
         ) bounded_lines
       ), ARRAY[]::text[]) AS lines,
       COALESCE((
         SELECT array_agg(boundary ORDER BY boundary) FROM (
           SELECT boundary FROM boundary_rows WHERE kind='veil'
           ORDER BY boundary LIMIT ${MAX_SESSION_BOUNDARIES + 1}
         ) bounded_veils
       ), ARRAY[]::text[]) AS veils,
       (SELECT COUNT(*)::int FROM boundary_rows) AS boundary_count`,
    [sessionId],
  );
  const result = rows[0] ?? { lines: [], veils: [], boundary_count: 0 };
  if (result.boundary_count > MAX_SESSION_BOUNDARIES)
    throw new Error('Session content boundary limit exceeded');
  return { lines: result.lines, veils: result.veils };
}
