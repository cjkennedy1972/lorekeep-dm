import type { Pool } from 'pg';
import { computeContentTier, type ContentTier, type HostCap } from './tier.js';

type Queryable = Pick<Pool, 'query'>;

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
  }>(
    'SELECT content_tier, moderation_verified, host_tier_cap FROM sessions WHERE id=$1',
    [sessionId],
  );
  const session = rows[0];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const tier = computeContentTier({
    seatedMatureOptOuts: await loadSeatedMatureOptOuts(db, sessionId),
    moderationVerified: session.moderation_verified,
    endpointAllowsMature,
    hostCap: session.host_tier_cap ?? undefined,
  });
  return { tier, stored: session.content_tier };
}

/**
 * Live mature opt-out for every account that has ever been seated in the session. The seat's
 * join-time snapshot is not used; a seated account with no row, or a status other than active
 * (e.g. deleting), counts as opted out.
 */
export async function loadSeatedMatureOptOuts(
  db: Queryable,
  sessionId: string,
): Promise<boolean[]> {
  const { rows } = await db.query<{ opted_out: boolean }>(
    `SELECT (a.id IS NULL OR a.status <> 'active' OR a.mature_opt_out IS NOT FALSE) AS opted_out
       FROM (SELECT DISTINCT payload->>'accountId' AS account_id FROM events
              WHERE session_id=$1 AND type='SeatJoined' AND payload->>'accountId' IS NOT NULL) seated
       LEFT JOIN accounts a ON a.id = seated.account_id::uuid`,
    [sessionId],
  );
  return rows.map((row) => row.opted_out);
}

/**
 * Union personal lines and veils for every account ever seated at this shared table.
 * The lists stay account-private in storage; only the unattributed union is used by
 * narration and moderation. Missing/deleted accounts contribute no free-text data.
 */
export async function loadSeatedContentBoundaries(
  db: Queryable,
  sessionId: string,
): Promise<{ lines: string[]; veils: string[] }> {
  const { rows } = await db.query<{ lines: string[]; veils: string[] }>(
    `WITH seated AS (
       SELECT DISTINCT payload->>'accountId' AS account_id
         FROM events
        WHERE session_id=$1 AND type='SeatJoined'
          AND payload->>'accountId' IS NOT NULL
     )
     SELECT
       COALESCE((
         SELECT array_agg(DISTINCT boundary ORDER BY boundary)
           FROM seated s JOIN accounts a ON a.id=s.account_id::uuid
           CROSS JOIN LATERAL unnest(a.content_lines) AS boundary
       ), ARRAY[]::text[]) AS lines,
       COALESCE((
         SELECT array_agg(DISTINCT boundary ORDER BY boundary)
           FROM seated s JOIN accounts a ON a.id=s.account_id::uuid
           CROSS JOIN LATERAL unnest(a.content_veils) AS boundary
       ), ARRAY[]::text[]) AS veils`,
    [sessionId],
  );
  return rows[0] ?? { lines: [], veils: [] };
}
