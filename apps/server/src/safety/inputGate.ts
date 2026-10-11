import type { Pool } from 'pg';
import type { LlmAdapter } from '../llm/adapter.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
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
  sessionId?: string;
}

/** Resolves true when the input may be stored or sent to the DM. Never throws. */
export interface InputGate {
  check(input: InputCheck): Promise<boolean>;
}

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

  // Stores IDs, the category and the source only. The text is never written (ADR-017).
  async function record(
    input: InputCheck,
    category: Category,
    source: 'hardfloor' | 'denylist' | 'judge' | 'failclosed',
    failClosedRow?: 'hard-floor' | 'tier',
  ) {
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
      const hard = checkHardFloor(input.text);
      if (hard.blocked) {
        // ponytail: the hard floor only has minor rules today; map by rule when more land.
        await record(
          input,
          hard.rule === 'input.over-limit' ? 'other' : 'minor_sexual',
          'hardfloor',
        );
        return false;
      }
      const verdict = await moderator.moderate({
        text: input.text,
        tier: await tierFor(input.sessionId),
        direction: 'input',
      });
      if (verdict.verdict === 'allow') return true;
      await record(
        input,
        verdict.category,
        verdict.source,
        verdict.unavailable ? verdict.failClosedRow : undefined,
      );
      return false;
    },
  };
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
      let text = '';
      for await (const chunk of adapter.complete({
        messages,
        maxTokens: max_tokens,
        temperature,
        signal,
      })) {
        if (chunk.type === 'text') text += chunk.delta;
      }
      return text;
    },
  });
}
