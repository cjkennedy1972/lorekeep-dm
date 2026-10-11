import type { Pool } from 'pg';
import type { LlmAdapter } from '../llm/adapter.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import { BoundedCounter } from '../accounts/throttle.js';
import { checkHardFloor } from './hardFloor.js';
import {
  JudgeModerator,
  MAX_RULE_SPAN_CHARS,
  type Category,
  type JudgeChat,
  type Moderator,
} from './moderator.js';
import type { ContentTier } from './tier.js';
import { loadContentTierState } from './tierLoader.js';

export const INPUT_SURFACES = [
  'player-action',
  'clarification',
  'character',
  'table-name',
  'room-name',
  'display-name',
  'report-reason',
] as const;
export type InputSurface = (typeof INPUT_SURFACES)[number];

export type InputGateDb = Pick<Pool, 'query'>;
interface WarnLog {
  warn: (obj: object, msg: string) => void;
}

export interface InputCheck {
  text: string;
  surface: InputSurface;
  accountId?: string;
  ip?: string;
  sessionId?: string;
}

/** `limited`: over the moderation-call budget; the judge was not called and nothing was logged. */
export type InputDecision = 'allow' | 'block' | 'limited';

/** Never throws. */
export interface InputGate {
  check(input: InputCheck): Promise<InputDecision>;
}

export const MODERATION_CALLS_PER_MINUTE = { account: 30, ip: 20 } as const;
export const MODERATION_LOG_ROWS_PER_DAY = 100;
export const JUDGE_MAX_RESPONSE_BYTES = 16 * 1024;
export const HARD_FLOOR_LOG_RETENTION_MS = 30 * 86_400_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

interface InputGateOptions {
  db: InputGateDb;
  moderator: Moderator;
  log: WarnLog;
}

// Names have no session; family is the strictest rubric.
const NAME_TIER: ContentTier = 'family';

export function createInputGate({
  db,
  moderator,
  log,
}: InputGateOptions): InputGate {
  async function tierFor(sessionId?: string): Promise<ContentTier> {
    if (!sessionId) return NAME_TIER;
    try {
      return (await loadContentTierState(db, sessionId, false)).tier;
    } catch {
      return NAME_TIER;
    }
  }

  const callsByAccount = new BoundedCounter(MINUTE_MS);
  const callsByIp = new BoundedCounter(MINUTE_MS);
  const rowsByKey = new BoundedCounter(DAY_MS);

  function overBudget(input: InputCheck): boolean {
    let limited = false;
    if (input.accountId !== undefined)
      limited =
        callsByAccount.hit(input.accountId) >
          MODERATION_CALLS_PER_MINUTE.account || limited;
    if (input.ip !== undefined)
      limited =
        callsByIp.hit(input.ip) > MODERATION_CALLS_PER_MINUTE.ip || limited;
    return limited;
  }

  // Stores IDs, the category and the source only. The text is never written (ADR-017).
  async function record(
    input: InputCheck,
    category: Category,
    source: 'hardfloor' | 'denylist' | 'judge' | 'failclosed',
    failClosedRow?: 'hard-floor' | 'tier',
  ) {
    const key = input.accountId ?? input.ip ?? 'anonymous';
    const rows = rowsByKey.hit(key);
    if (rows > MODERATION_LOG_ROWS_PER_DAY) {
      if (rows === MODERATION_LOG_ROWS_PER_DAY + 1)
        log.warn(
          { event: 'moderation_log_cap_reached', surface: input.surface },
          'moderation log daily cap reached; further rows dropped',
        );
      return;
    }
    try {
      await db.query(
        `INSERT INTO moderation_log(surface,account_id,session_id,category,source,fail_closed_row,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,now() + interval '30 days')`,
        [
          input.surface,
          input.accountId ?? null,
          input.sessionId ?? null,
          category,
          source,
          failClosedRow ?? null,
        ],
      );
    } catch {
      log.warn(
        { event: 'moderation_log_write_failed', surface: input.surface },
        'moderation log write failed',
      );
    }
  }

  return {
    async check(input) {
      if (overBudget(input)) return 'limited';
      const hard = checkHardFloor(input.text);
      if (hard.blocked) {
        log.warn(
          {
            event: 'hard_floor_block',
            surface: input.surface,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            rule: hard.rule,
            version: hard.version,
            expiresAt: new Date(
              Date.now() + HARD_FLOOR_LOG_RETENTION_MS,
            ).toISOString(),
          },
          'hard floor rejected input',
        );
        // ponytail: the hard floor only has minor rules today; map by rule when more land.
        await record(
          input,
          hard.rule === 'input.over-limit' ? 'other' : 'minor_sexual',
          'hardfloor',
        );
        return 'block';
      }
      const verdict = await moderator.moderate({
        text: input.text,
        tier: await tierFor(input.sessionId),
        direction: 'input',
      });
      if (verdict.verdict === 'allow') return 'allow';
      await record(
        input,
        verdict.category,
        verdict.source,
        verdict.unavailable ? verdict.failClosedRow : undefined,
      );
      return 'block';
    },
  };
}

/** Accumulates judge text; throws past the cap so an oversized reply fails closed as an outage. */
export async function collectJudgeText(
  chunks: AsyncIterable<{ type: string; delta?: string }>,
): Promise<string> {
  let text = '';
  let bytes = 0;
  for await (const chunk of chunks) {
    if (chunk.type !== 'text' || chunk.delta === undefined) continue;
    bytes += Buffer.byteLength(chunk.delta);
    if (bytes > JUDGE_MAX_RESPONSE_BYTES)
      throw new Error('judge response too large');
    text += chunk.delta;
  }
  return text;
}

export function createModerationJudge({
  chat,
}: {
  chat: JudgeChat;
}): JudgeModerator {
  return new JudgeModerator({
    chat,
    deterministic: {
      hardFloorCheck: (text) =>
        checkHardFloor(text).blocked
          ? { blocked: true, category: 'minor_sexual' }
          : { blocked: false },
      // ponytail: the SRD denylist is output-side (M3-08); input has none yet.
      denylistCheck: () => ({ blocked: false }),
      maxSpanChars: MAX_RULE_SPAN_CHARS,
    },
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    inputGate: InputGate;
  }
}

/** Judge on the operator's `moderate` endpoint only (R-L5); no other egress path. */
export function createEndpointJudge(db: InputGateDb): JudgeModerator {
  const egress = createEndpointEgress();
  return createModerationJudge({
    chat: async ({ messages, max_tokens, temperature, signal }) => {
      const adapter: LlmAdapter = await createConfiguredAdapter(
        db,
        'moderate',
        egress,
      );
      return collectJudgeText(
        adapter.complete({
          messages,
          maxTokens: max_tokens,
          temperature,
          signal,
        }),
      );
    },
  });
}
