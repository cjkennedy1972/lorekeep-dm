import type { Pool } from 'pg';
import type { LlmAdapter } from '../llm/adapter.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import { BoundedCounter } from '../accounts/throttle.js';
import { checkHardFloor } from './hardFloor.js';
import { hardFloorLayer } from './deterministicLayer.js';
import { loadSeatedContentBoundaries } from './tierLoader.js';
import {
  JudgeModerator,
  type Category,
  type JudgeChat,
  type Moderator,
  type VerdictParser,
} from './moderator.js';
import type { ContentTier } from './tier.js';
import { loadContentTierState } from './tierLoader.js';
import { endpointJudgeBudget, withJudgeHardCap } from './judgeBudget.js';

export const INPUT_SURFACES = [
  'player-action',
  'clarification',
  'chat',
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
  signal?: AbortSignal;
}

/** `limited`: over the moderation-call budget; the judge was not called and nothing was logged. */
export type InputDecision = 'allow' | 'block' | 'limited' | 'busy';

/** Never throws. */
export interface InputGate {
  check(input: InputCheck): Promise<InputDecision>;
  checkChat?(input: InputCheck): Promise<ChatInputResult>;
  logChatRejection?(input: ChatRejectionLog): Promise<string | undefined>;
  logChatFailure?(input: ChatRejectionLog): Promise<string | undefined>;
}

export type ChatRejectionLog = Pick<
  InputCheck,
  'surface' | 'accountId' | 'ip' | 'sessionId'
>;

export interface ChatInputResult {
  decision: InputDecision;
  moderationLogId?: string;
  category?: Category;
  source?: 'hardfloor' | 'denylist' | 'judge' | 'failclosed';
  attributable: boolean;
}

export const MODERATION_CALLS_PER_MINUTE = { account: 30, ip: 20 } as const;
export const CHAT_CALLS_PER_TABLE_PER_MINUTE = 40;
export const ACTION_CALLS_PER_TABLE_PER_MINUTE = 48;
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
  const chatCallsByTable = new BoundedCounter(MINUTE_MS);
  const actionCallsByTable = new BoundedCounter(MINUTE_MS);
  const rowsByKey = new BoundedCounter(DAY_MS);

  function overBudget(input: InputCheck): boolean {
    let limited = false;
    if (input.accountId !== undefined)
      limited =
        callsByAccount.hit(
          input.surface === 'chat'
            ? `chat:${input.accountId}`
            : input.accountId,
        ) > MODERATION_CALLS_PER_MINUTE.account || limited;
    if (input.ip !== undefined)
      limited =
        callsByIp.hit(input.ip) > MODERATION_CALLS_PER_MINUTE.ip || limited;
    return limited;
  }

  // Stores IDs, the category and the source only. The text is never written (ADR-017).
  async function record(
    input: ChatRejectionLog,
    category: Category,
    source: 'hardfloor' | 'denylist' | 'judge' | 'failclosed' | 'rate-limit',
    failClosedRow?: 'hard-floor' | 'tier' | 'boundaries',
  ): Promise<string | undefined> {
    const key = input.accountId ?? input.ip ?? 'anonymous';
    const rows = rowsByKey.hit(key);
    if (rows > MODERATION_LOG_ROWS_PER_DAY) {
      if (rows === MODERATION_LOG_ROWS_PER_DAY + 1)
        log.warn(
          { event: 'moderation_log_cap_reached', surface: input.surface },
          'moderation log daily cap reached; further rows dropped',
        );
      return undefined;
    }
    try {
      const result = await db.query<{ id: string }>(
        `INSERT INTO moderation_log(surface,account_id,session_id,category,source,fail_closed_row,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,now() + interval '30 days') RETURNING id`,
        [
          input.surface,
          input.accountId ?? null,
          input.sessionId ?? null,
          category,
          source,
          failClosedRow ?? null,
        ],
      );
      return result.rows[0]?.id;
    } catch {
      log.warn(
        { event: 'moderation_log_write_failed', surface: input.surface },
        'moderation log write failed',
      );
      return undefined;
    }
  }

  async function evaluate(input: InputCheck): Promise<ChatInputResult> {
    if (
      input.surface === 'chat' &&
      input.sessionId !== undefined &&
      chatCallsByTable.hit(input.sessionId) > CHAT_CALLS_PER_TABLE_PER_MINUTE
    )
      return { decision: 'limited', attributable: false };
    if (overBudget(input)) return { decision: 'limited', attributable: false };
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
      const moderationLogId = await record(
        input,
        hard.rule === 'input.over-limit' ? 'other' : 'minor_sexual',
        'hardfloor',
      );
      return {
        decision: 'block',
        moderationLogId,
        category: hard.rule === 'input.over-limit' ? 'other' : 'minor_sexual',
        source: 'hardfloor',
        attributable: true,
      };
    }
    let boundaries:
      | Awaited<ReturnType<typeof loadSeatedContentBoundaries>>
      | undefined;
    if (input.sessionId) {
      try {
        boundaries = await loadSeatedContentBoundaries(db, input.sessionId);
      } catch {
        log.warn(
          { event: 'content_boundaries_unavailable', surface: input.surface },
          'content boundaries unavailable; input blocked',
        );
        const moderationLogId = await record(
          input,
          'other',
          'failclosed',
          'tier',
        );
        return {
          decision: 'block',
          moderationLogId,
          category: 'other',
          source: 'failclosed',
          attributable: false,
        };
      }
    }
    if (
      (input.surface === 'player-action' ||
        input.surface === 'clarification') &&
      input.sessionId !== undefined &&
      actionCallsByTable.hit(input.sessionId) >
        ACTION_CALLS_PER_TABLE_PER_MINUTE
    )
      return { decision: 'busy', attributable: false };
    const verdict = await moderator.moderate({
      text: input.text,
      tier: await tierFor(input.sessionId),
      tableLines: boundaries
        ? [
            ...boundaries.lines.map((line) => `line: ${line}`),
            ...boundaries.veils.map((veil) => `veil: ${veil}`),
          ]
        : undefined,
      direction: 'input',
      budgetClass: input.surface === 'chat' ? 'chat' : 'action-input',
      signal: input.signal,
    });
    if (verdict.verdict === 'allow') {
      const moderationLogId =
        input.surface === 'chat'
          ? await record(input, 'none', 'judge')
          : undefined;
      return {
        decision: 'allow',
        moderationLogId,
        category: 'none',
        source: 'judge',
        attributable: input.surface !== 'chat' || moderationLogId !== undefined,
      };
    }
    if (verdict.capacityLimited) {
      const actionSurface =
        input.surface === 'player-action' || input.surface === 'clarification';
      return {
        decision:
          actionSurface && verdict.capacityLimited === 'action-input'
            ? 'busy'
            : 'limited',
        attributable: false,
      };
    }
    const moderationLogId = await record(
      input,
      verdict.category,
      verdict.source,
      verdict.unavailable ? verdict.failClosedRow : undefined,
    );
    return {
      decision: 'block',
      moderationLogId,
      category: verdict.category,
      source: verdict.source,
      attributable: !verdict.unavailable,
    };
  }

  return {
    async check(input) {
      return (await evaluate(input)).decision;
    },
    checkChat(input) {
      return evaluate({ ...input, surface: 'chat' });
    },
    logChatRejection(input) {
      return record(input, 'other', 'rate-limit');
    },
    logChatFailure(input) {
      return record(input, 'other', 'failclosed', 'tier');
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
  parseVerdictReply,
}: {
  chat: JudgeChat;
  parseVerdictReply?: VerdictParser;
}): JudgeModerator {
  return new JudgeModerator({
    chat,
    deterministic: hardFloorLayer,
    ...(parseVerdictReply ? { parseVerdictReply } : {}),
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    inputGate: InputGate;
  }
}

/** Judge on the operator's `moderate` endpoint only (R-L5); no other egress path. */
export function createEndpointJudge(
  db: InputGateDb,
  parseVerdictReply?: VerdictParser,
): JudgeModerator {
  const egress = createEndpointEgress();
  return createModerationJudge({
    ...(parseVerdictReply ? { parseVerdictReply } : {}),
    chat: async ({
      messages,
      max_tokens,
      temperature,
      signal,
      direction,
      budgetClass,
    }) => {
      const budget = endpointJudgeBudget.acquire(
        direction === 'output' ? 'output' : (budgetClass ?? 'action-input'),
      );
      if (budget.kind === 'limited')
        return { kind: 'limited', class: budget.class };
      let currentAdapter: LlmAdapter | undefined;
      let destroyed = false;
      const operation = (async () => {
        const adapter: LlmAdapter = await createConfiguredAdapter(
          db,
          'moderate',
          egress,
        );
        // A hard-cap timer can fire while adapter setup is pending.
        if (destroyed) adapter.destroy?.();
        // Keep the handle so the 60 s bound can destroy this call's transport.
        currentAdapter = adapter;
        return await collectJudgeText(
          adapter.complete({
            messages,
            maxTokens: max_tokens,
            temperature,
            signal,
          }),
        );
      })();
      let callerLostTimer: ReturnType<typeof setTimeout> | undefined;
      const onCallerAbort = () => {
        if (callerLostTimer !== undefined) return;
        // Keep a slot in flight for 10 s after abort; then count unsettled work as lost until settlement or the 60 s hard cap.
        callerLostTimer = setTimeout(() => budget.markLost(), 10_000);
      };
      signal.addEventListener('abort', onCallerAbort, { once: true });
      if (signal.aborted) onCallerAbort();
      const clearCallerLostTimer = () => {
        if (callerLostTimer !== undefined) clearTimeout(callerLostTimer);
      };
      void operation.then(clearCallerLostTimer, clearCallerLostTimer);
      return withJudgeHardCap(
        operation,
        budget.release,
        budget.markLost,
        undefined,
        () => {
          destroyed = true;
          currentAdapter?.destroy?.();
        },
      ).finally(() => signal.removeEventListener('abort', onCallerAbort));
    },
  });
}
