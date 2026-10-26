import type { Pool } from 'pg';
import type { LlmAdapter } from '../llm/adapter.js';
import type { Moderator } from '../safety/moderator.js';
import type { ContentTier } from '../safety/tier.js';
import { hiddenMatcher, type HiddenEntity } from './summarize.js';
import {
  MAX_RECAP_CHARS,
  MAX_RECAP_WORDS,
  buildRecap,
  gateRecap,
} from './recap.js';

export const LATE_JOIN_EMPTY_RECAP = 'The adventure is just getting started.';
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

/**
 * Recap inputs every seat may already see: scene summaries and public registry entries only.
 * Never events, chat, or `flag`/`ruling` (DM-internal) rows. When any character binding in the
 * session was redacted by account deletion, its name can no longer be matched, so scene
 * summaries (which narrate PCs by name) are dropped and only registry facts remain.
 */
async function loadMemories(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  hidden: readonly HiddenEntity[],
): Promise<{ memories: string[]; names: string[] }> {
  const bindings = await db.query<{ name: string | null; redacted: boolean }>(
    `SELECT character_snapshot->>'name' AS name, binding_status='redacted' AS redacted
       FROM session_seat_characters WHERE session_id=$1`,
    [sessionId],
  );
  const redacted = bindings.rows.some((row) => row.redacted);
  const names = bindings.rows.flatMap((row) => (row.name ? [row.name] : []));
  const summaries = redacted
    ? { rows: [] as { text: string }[] }
    : await db.query<{ text: string }>(
        `SELECT concat('Scene ', scene_id, ': ', summary) AS text
           FROM scene_summaries WHERE session_id=$1
          ORDER BY created_at DESC, id DESC LIMIT 8`,
        [sessionId],
      );
  const registry = await db.query<{ text: string }>(
    `SELECT concat(e.entity_type, ' ', e.name, ': ', f.fact) AS text
       FROM registry_entries e JOIN registry_facts f ON f.entry_id=e.id
      WHERE e.session_id=$1 AND e.entity_type IN ('npc','location','quest')
        AND e.superseded_by IS NULL AND f.superseded_by IS NULL
      ORDER BY e.mentioned_at DESC, e.id, f.id LIMIT 32`,
    [sessionId],
  );
  return {
    memories: [...summaries.rows, ...registry.rows]
      .map((row) =>
        hiddenMatcher(hidden).scrub(scrubLateJoinText(row.text, names)),
      )
      .filter(Boolean),
    names,
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
  moderator: Moderator;
  tier: ContentTier;
  tableLines: readonly string[];
  adapter?: LlmAdapter;
  timeoutMs?: number;
  /** Entities hidden at the table now; rows written before write-side filtering may still name them. */
  hidden?: readonly HiddenEntity[];
}): Promise<LateJoinRecapResult> {
  let memories: string[] = [];
  let names: string[] = [];
  try {
    ({ memories, names } = await loadMemories(
      input.db,
      input.sessionId,
      input.hidden ?? [],
    ));
  } catch {
    // fall through to the neutral text
  }
  const built = await buildRecap({
    memories,
    changed: true,
    adapter: input.adapter,
    signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
  });
  const recap = hiddenMatcher(input.hidden ?? [])
    .scrub(scrubLateJoinText(built.recap, names))
    .split(' ')
    .slice(0, MAX_RECAP_WORDS)
    .join(' ')
    .slice(0, MAX_RECAP_CHARS)
    .trim();
  const gated = await gateRecap(
    {
      ...built,
      recap: recap || LATE_JOIN_EMPTY_RECAP,
      fallback: built.fallback || !recap,
    },
    input.moderator,
    input.tier,
    input.tableLines,
  );
  return { recap: gated.recap, fallback: gated.fallback };
}
