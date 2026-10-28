import type { Pool } from 'pg';
import type { LlmAdapter } from '../llm/adapter.js';
import type { Moderator } from '../safety/moderator.js';
import type { ContentTier } from '../safety/tier.js';
import { hiddenMatcher, type HiddenEntity } from './summarize.js';
import {
  MAX_RECAP_CHARS,
  MAX_RECAP_WORDS,
  buildPlayerVisibleRecap,
  gateRecap,
} from './recap.js';

const PARTY_MEMBER = 'a party member';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Quoted speech and every named party character are removed before and after any LLM call. */
export function scrubLateJoinText(
  text: string,
  names: readonly string[],
): string {
  let out = text.replace(/"[^"]*"|“[^”]*”/g, ' ');
  for (const name of names.map((n) => n.trim()).filter(Boolean))
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'),
      PARTY_MEMBER,
    );
  return out.replace(/\s+/g, ' ').trim();
}

/** Load only names needed to keep late-join text from identifying seated characters. */
async function loadCharacterNames(
  db: Pick<Pool, 'query'>,
  sessionId: string,
): Promise<{ names: string[]; redacted: boolean }> {
  const bindings = await db.query<{ name: string | null; redacted: boolean }>(
    `SELECT character_snapshot->>'name' AS name, binding_status='redacted' AS redacted
       FROM session_seat_characters WHERE session_id=$1`,
    [sessionId],
  );
  return {
    names: bindings.rows.flatMap((row) => (row.name ? [row.name] : [])),
    redacted: bindings.rows.some((row) => row.redacted),
  };
}

export interface LateJoinRecapResult {
  recap: string;
  fallback: boolean;
}

/** Never throws and never waits on the LLM longer than `timeoutMs`; a join is not blocked by the recap. */
export async function buildLateJoinRecap(input: {
  db: Pick<Pool, 'query'>;
  sessionId: string;
  accountId?: string;
  moderator: Moderator;
  tier: ContentTier;
  tableLines: readonly string[];
  adapter?: LlmAdapter;
  timeoutMs?: number;
  /** Entities hidden at the table now; rows written before write-side filtering may still name them. */
  hidden?: readonly HiddenEntity[];
}): Promise<LateJoinRecapResult> {
  let names: string[] = [];
  let hasRedactedSeat = false;
  try {
    const bindings = await loadCharacterNames(input.db, input.sessionId);
    names = bindings.names;
    hasRedactedSeat = bindings.redacted;
  } catch {
    // Without binding visibility, fail closed instead of risking a seated-character name.
    hasRedactedSeat = true;
  }
  const built = await buildPlayerVisibleRecap({
    db: input.db,
    sessionId: input.sessionId,
    accountId: input.accountId ?? '',
    changed: true,
    adapter: hasRedactedSeat ? undefined : input.adapter,
    signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    hidden: input.hidden,
  });
  const recap = hiddenMatcher(input.hidden ?? [])
    .scrub(hasRedactedSeat ? '' : scrubLateJoinText(built.recap, names))
    .split(' ')
    .slice(0, MAX_RECAP_WORDS)
    .join(' ')
    .slice(0, MAX_RECAP_CHARS)
    .trim();
  const gated = await gateRecap(
    {
      ...built,
      recap,
      fallback: built.fallback || (!recap && Boolean(built.recap)),
    },
    input.moderator,
    input.tier,
    input.tableLines,
    input.sessionId,
  );
  return { recap: gated.recap, fallback: gated.fallback };
}
