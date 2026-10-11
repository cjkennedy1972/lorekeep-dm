import type { ContentTier } from './tier.js';
import {
  MODERATION_CATEGORIES,
  MODERATION_SECTIONS,
} from './moderationRubric.generated.js';

export type Category = (typeof MODERATION_CATEGORIES)[number];
export type Direction = 'input' | 'output';

export interface Verdict {
  verdict: 'allow' | 'block';
  category: Category;
  source: 'hardfloor' | 'denylist' | 'judge' | 'failclosed';
  latencyMs: number;
  /** True when the judge could not produce a usable verdict (fail-closed). */
  unavailable: boolean;
}

export interface ModerationRequest {
  text: string;
  tier: ContentTier;
  tableLines?: readonly string[];
  direction: Direction;
}

export interface Moderator {
  moderate(req: ModerationRequest): Promise<Verdict>;
}

export interface DeterministicCheckResult {
  blocked: boolean;
  category?: Category;
}

/** Rules run before any judge call; a block here is final. */
export interface DeterministicLayer {
  hardFloorCheck(text: string): DeterministicCheckResult;
  denylistCheck(text: string): DeterministicCheckResult;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface JudgeChatRequest {
  messages: ChatMessage[];
  temperature: 0;
  max_tokens: number;
  signal: AbortSignal;
}

/** OpenAI-compatible chat call returning the assistant message content. */
export type JudgeChat = (req: JudgeChatRequest) => Promise<string>;

export const JUDGE_MAX_TOKENS = 1024;
export const DEFAULT_JUDGE_TIMEOUT_MS = 4_500;

const RUBRIC_TAG = {
  family: 'rubric:family',
  standard: 'rubric:standard',
  mature: 'rubric:mature',
} as const satisfies Record<ContentTier, keyof typeof MODERATION_SECTIONS>;

const CATEGORY_SET: ReadonlySet<string> = new Set(MODERATION_CATEGORIES);

export function parseVerdictReply(
  raw: unknown,
): { verdict: 'allow' | 'block'; category: Category } | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'category' || keys[1] !== 'verdict')
    return null;
  if (
    (text.match(/"verdict"\s*:/g) ?? []).length !== 1 ||
    (text.match(/"category"\s*:/g) ?? []).length !== 1
  ) {
    return null;
  }
  const { verdict, category } = parsed as Record<string, unknown>;
  if (verdict !== 'allow' && verdict !== 'block') return null;
  if (typeof category !== 'string' || !CATEGORY_SET.has(category)) return null;
  if (verdict === 'allow' && category !== 'none') return null;
  if (verdict === 'block' && category === 'none') return null;
  return { verdict, category: category as Category };
}

const quoteData = (value: string) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function buildJudgeMessages(req: ModerationRequest): ChatMessage[] {
  const system = `${MODERATION_SECTIONS[RUBRIC_TAG[req.tier]]}\n\n${MODERATION_SECTIONS['verdict-schema']}`;
  const tableLines = (req.tableLines ?? []).map(quoteData).join('\n');
  const user = `<table_lines>\n${tableLines}\n</table_lines>\n<text>\n${quoteData(req.text)}\n</text>`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface JudgeModeratorOptions {
  chat: JudgeChat;
  deterministic: DeterministicLayer;
  timeoutMs?: number;
  now?: () => number;
}

const TIMED_OUT = { ok: false } as const;

export class JudgeModerator implements Moderator {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: JudgeModeratorOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
  }

  async moderate(req: ModerationRequest): Promise<Verdict> {
    const started = this.now();
    const elapsed = () => this.now() - started;
    const failClosed = (): Verdict => ({
      verdict: 'block',
      category: 'other',
      source: 'failclosed',
      latencyMs: elapsed(),
      unavailable: true,
    });

    let rule: { category: Category; source: 'hardfloor' | 'denylist' } | null =
      null;
    try {
      const hard = this.options.deterministic.hardFloorCheck(req.text);
      if (hard.blocked)
        rule = { category: hard.category ?? 'other', source: 'hardfloor' };
      else {
        const denied = this.options.deterministic.denylistCheck(req.text);
        if (denied.blocked)
          rule = { category: denied.category ?? 'other', source: 'denylist' };
      }
    } catch {
      return failClosed();
    }
    if (rule) {
      return {
        verdict: 'block',
        ...rule,
        latencyMs: elapsed(),
        unavailable: false,
      };
    }

    const judged = await this.judge(req);
    if (judged === null) return failClosed();
    return {
      ...judged,
      source: 'judge',
      latencyMs: elapsed(),
      unavailable: false,
    };
  }

  private async judge(req: ModerationRequest) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, this.timeoutMs);
    });
    const call = Promise.resolve()
      .then(() =>
        this.options.chat({
          messages: buildJudgeMessages(req),
          temperature: 0,
          max_tokens: JUDGE_MAX_TOKENS,
          signal: controller.signal,
        }),
      )
      .then(
        (raw) => ({ ok: true as const, raw }),
        () => TIMED_OUT,
      );
    try {
      const result = await Promise.race([call, timeout]);
      if (!result.ok) return null;
      return parseVerdictReply(result.raw);
    } finally {
      clearTimeout(timer);
    }
  }
}
