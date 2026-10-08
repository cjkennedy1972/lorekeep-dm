import type { Pool } from 'pg';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
  TokenUsage,
} from './adapter.js';

export type UsagePurpose =
  | 'narration'
  | 'summary'
  | 'classification'
  | 'moderation';
export interface UsageContext {
  sessionId: string;
  turnId: string;
  purpose: UsagePurpose;
  modelId: string;
  retries?: number;
}
export interface UsageRecord {
  sessionId: string;
  turnId: string;
  purpose: UsagePurpose;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  estimated: boolean;
  latencyMs: number;
  retries: number;
  errorCode: string | null;
}
export interface UsageSink {
  record(entry: UsageRecord): Promise<void>;
}
export class PostgresUsageSink implements UsageSink {
  constructor(private readonly db: Pick<Pool, 'query'>) {}
  async record(entry: UsageRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO endpoint_usage(session_id,turn_id,purpose,model_id,input_tokens,output_tokens,cached_tokens,cache_write_tokens,estimated,latency_ms,retries,error_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.sessionId,
        entry.turnId,
        entry.purpose,
        entry.modelId,
        entry.inputTokens,
        entry.outputTokens,
        entry.cachedTokens,
        entry.cacheWriteTokens,
        entry.estimated,
        entry.latencyMs,
        entry.retries,
        entry.errorCode,
      ],
    );
  }
}
const estimate = (request: LlmRequest, text: string): TokenUsage => ({
  input: Math.ceil(
    request.messages.reduce((n, message) => n + message.content.length, 0) / 4,
  ),
  output: Math.ceil(text.length / 4),
  estimate: true,
});

/** Wraps each complete() invocation and writes exactly one counts-only row, even on failure. */
export class MeteredLlmAdapter implements LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly sink: UsageSink,
    private readonly context: UsageContext,
    private readonly onMeteringError: (error: unknown) => void = () =>
      undefined,
    private readonly now: () => number = Date.now,
  ) {}
  capabilities() {
    return this.inner.capabilities();
  }
  probe(signal?: AbortSignal) {
    return this.inner.probe(signal);
  }
  async *complete(request: LlmRequest): AsyncIterable<LlmChunk> {
    const started = this.now();
    let text = '';
    let usage: TokenUsage | undefined;
    let errorCode: string | null = null;
    try {
      for await (const chunk of this.inner.complete(request)) {
        if (chunk.type === 'text') text += chunk.delta;
        if (chunk.type === 'usage') usage = chunk.usage;
        yield chunk;
      }
    } catch (error) {
      errorCode =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'endpoint-error';
      throw error;
    } finally {
      const tokens = usage ?? estimate(request, text);
      if (errorCode && !usage) tokens.output = 0;
      try {
        await this.sink.record({
          sessionId: this.context.sessionId,
          turnId: this.context.turnId,
          purpose: this.context.purpose,
          modelId: this.context.modelId,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cachedTokens: tokens.cacheRead ?? 0,
          cacheWriteTokens: tokens.cacheWrite ?? 0,
          estimated: tokens.estimate,
          latencyMs: Math.max(0, this.now() - started),
          retries: this.context.retries ?? 0,
          errorCode,
        });
      } catch (meterError) {
        this.onMeteringError(meterError);
      }
    }
  }
}

export async function readUsage(db: Pick<Pool, 'query'>, sessionId?: string) {
  const result = await db.query(
    `SELECT session_id AS "sessionId", count(*)::int AS "calls",
       coalesce(sum(input_tokens),0)::int AS "inputTokens",
       coalesce(sum(output_tokens),0)::int AS "outputTokens",
       coalesce(sum(cached_tokens),0)::int AS "cachedTokens",
       coalesce(sum(cache_write_tokens),0)::int AS "cacheWriteTokens",
       coalesce(sum(latency_ms),0)::bigint AS "latencyMs",
       coalesce(sum(retries),0)::int AS retries,
       count(*) FILTER (WHERE estimated)::int AS "estimatedCalls",
       count(*) FILTER (WHERE error_code IS NOT NULL)::int AS "errorCalls"
     FROM endpoint_usage WHERE ($1::uuid IS NULL OR session_id=$1)
     GROUP BY session_id ORDER BY session_id`,
    [sessionId ?? null],
  );
  return result.rows;
}
