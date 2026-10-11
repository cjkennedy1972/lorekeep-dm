import type { ContentTier } from './tier.js';
import {
  failClosedVerdict,
  MAX_RULE_SPAN_CHARS,
  type Category,
  type Moderator,
  type Verdict,
} from './moderator.js';

export const SAFE_REDIRECT_TEMPLATE =
  'The narrator pauses, and the scene turns to the next thing the party notices.';

export const MAX_REGENERATIONS = 2;
export const DEFAULT_MAX_IN_FLIGHT = 2;
export const DEFAULT_MAX_CHUNK_CHARS = 400;
export const DEFAULT_MAX_STREAM_CHARS = 20_000;
export const DEFAULT_MAX_TURN_CHARS = 30_000;
export const DEFAULT_SOURCE_IDLE_MS = 15_000;
export const DEFAULT_VERDICT_TIMEOUT_MS = 10_000;
// ponytail: judge-only carry; deterministic rules scan the whole turn (turnContext).
const CONTEXT_CHARS = 400;
const HOLD_BACK_CHARS = MAX_RULE_SPAN_CHARS;
const FIRST_CHUNK_TOKENS = 12;
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)|[。！？]+["'”’」』)\]]*/g;
const TRAILING_BOUNDARY = /[.!?…。！？"'”’」』)\]]/;
const SPACE = /\s/;
const STOPPED = Symbol('stopped');
const IDLE = Symbol('idle');

export interface ChunkMetric {
  attempt: number;
  verdict: Verdict['verdict'];
  category: Category;
  source: Verdict['source'];
  judgeLatencyMs: number;
  cutAtMs: number;
  decidedAtMs: number;
}

export interface GateMetrics {
  firstApprovedMs: number | null;
  regenerations: number;
  chunks: ChunkMetric[];
}

export type GateEvent =
  | { kind: 'chunk'; text: string; attempt: number; index: number }
  | { kind: 'regenerate'; attempt: number }
  | { kind: 'redirect'; text: typeof SAFE_REDIRECT_TEMPLATE }
  | { kind: 'end'; outcome: 'approved' | 'redirected'; metrics: GateMetrics };

export interface OutputGateOptions {
  /** Caller owns the first LLM call. `signal` aborts when the attempt is abandoned; the source must honor it. */
  stream: (signal: AbortSignal) => AsyncIterable<string>;
  /** Caller owns the LLM call. Receives the approved prefix so a retry continues it; `signal` aborts when the attempt is abandoned. */
  regenerate: (
    attempt: number,
    approved: readonly string[],
    signal: AbortSignal,
  ) => AsyncIterable<string>;
  moderator: Moderator;
  tier: ContentTier;
  tableLines?: readonly string[];
  now?: () => number;
  /** Max judge calls in flight; also caps chunks held unconsumed, so the upstream is read no faster than verdicts are taken. */
  maxInFlight?: number;
  /** Max characters per judged chunk; longer runs are cut at the last whitespace. */
  maxChunkChars?: number;
  /** Max characters read from one attempt's stream; exceeding it fails closed (block). */
  maxStreamChars?: number;
  /** Max characters read across all attempts of one turn; exceeding it fails closed and goes straight to the redirect. */
  maxTurnChars?: number;
  /** Max wait for the next upstream delta; a silent source fails the attempt. */
  sourceIdleMs?: number;
  /** Max wait for one verdict; a late verdict fails closed (block). */
  verdictTimeoutMs?: number;
}

type Chunk = { text: string; verdict: Promise<Verdict>; cutAtMs: number };
type Item = Chunk | 'end' | { error: unknown };

export function runOutputGate(
  opts: OutputGateOptions,
): AsyncGenerator<GateEvent> {
  const maxChunk = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  if (maxChunk < HOLD_BACK_CHARS)
    throw new Error(
      `maxChunkChars ${maxChunk} is below the ${HOLD_BACK_CHARS}-char hold-back`,
    );
  if (maxChunk > CONTEXT_CHARS)
    throw new Error(
      `maxChunkChars ${maxChunk} exceeds the ${CONTEXT_CHARS}-char deterministic carry`,
    );
  if (CONTEXT_CHARS < HOLD_BACK_CHARS)
    throw new Error(
      `deterministic carry ${CONTEXT_CHARS} is below the ${HOLD_BACK_CHARS}-char hold-back`,
    );
  return gate(opts);
}

async function* gate(opts: OutputGateOptions): AsyncGenerator<GateEvent> {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const maxChunk = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const maxStream = opts.maxStreamChars ?? DEFAULT_MAX_STREAM_CHARS;
  const maxTurn = opts.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;
  const sourceIdleMs = opts.sourceIdleMs ?? DEFAULT_SOURCE_IDLE_MS;
  const verdictTimeoutMs = opts.verdictTimeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS;
  const metrics: GateMetrics = {
    firstApprovedMs: null,
    regenerations: 0,
    chunks: [],
  };
  const approved: string[] = [];
  let turnRead = 0;
  let turnSpent = false;

  for (let attempt = 0; ; attempt++) {
    const abort = new AbortController();
    let source: AsyncIterable<string>;
    if (attempt === 0) {
      source = opts.stream(abort.signal);
    } else {
      metrics.regenerations = attempt;
      yield { kind: 'regenerate', attempt };
      source = opts.regenerate(attempt, [...approved], abort.signal);
    }
    const outcome = yield* runAttempt(source, attempt, abort);
    if (outcome === 'done') {
      return yield { kind: 'end', outcome: 'approved', metrics };
    }
    if (attempt === MAX_REGENERATIONS || turnSpent) {
      yield { kind: 'redirect', text: SAFE_REDIRECT_TEMPLATE };
      return yield { kind: 'end', outcome: 'redirected', metrics };
    }
  }

  async function* runAttempt(
    source: AsyncIterable<string>,
    attempt: number,
    abort: AbortController,
  ): AsyncGenerator<GateEvent, 'done' | 'blocked', undefined> {
    const queue: Item[] = [];
    let wakeConsumer: (() => void) | null = null;
    let wakeReader: (() => void) | null = null;
    let outstanding = 0;
    let stopped = false;
    const emittedBefore = approved.join('');
    let judged = '';
    let contextTail = emittedBefore.slice(-CONTEXT_CHARS);
    const it = source[Symbol.asyncIterator]();
    const stoppedSignal = new Promise<typeof STOPPED>((resolve) =>
      abort.signal.addEventListener('abort', () => resolve(STOPPED), {
        once: true,
      }),
    );

    const push = (item: Item) => {
      queue.push(item);
      const notify = wakeConsumer;
      wakeConsumer = null;
      notify?.();
    };
    const wakeReaderNow = () => {
      const notify = wakeReader;
      wakeReader = null;
      notify?.();
    };
    const releaseSlot = () => {
      outstanding--;
      wakeReaderNow();
    };
    const awaitSlot = async () => {
      while (outstanding >= maxInFlight && !stopped)
        await new Promise<void>((resolve) => (wakeReader = resolve));
    };

    const nextDelta = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), sourceIdleMs);
      });
      try {
        return await Promise.race([it.next(), idle, stoppedSignal]);
      } finally {
        clearTimeout(timer);
      }
    };

    const pushFailClosed = () => {
      const at = now() - start;
      push({
        text: '',
        verdict: Promise.resolve(failClosedVerdict(at)),
        cutAtMs: at,
      });
    };

    const classify = (text: string): Chunk => {
      const cutAtMs = now() - start;
      const context = contextTail;
      const turnContext = emittedBefore + judged;
      judged += text;
      contextTail = (contextTail + text).slice(-CONTEXT_CHARS);
      const timedOut = () => failClosedVerdict(now() - start - cutAtMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<Verdict>((resolve) => {
        timer = setTimeout(() => resolve(timedOut()), verdictTimeoutMs);
      });
      const verdict = Promise.race([
        Promise.resolve().then(() =>
          opts.moderator.moderate({
            text,
            context,
            turnContext,
            tier: opts.tier,
            tableLines: opts.tableLines,
            direction: 'output',
          }),
        ),
        bound,
      ])
        .catch(timedOut)
        .finally(() => clearTimeout(timer));
      return { text, verdict, cutAtMs };
    };

    void (async () => {
      let buffer = '';
      let pendingWs = '';
      let scanFrom = 0;
      let deltas = 0;
      let cuts = 0;
      let read = 0;

      const cutEnd = (): number => {
        SENTENCE_END.lastIndex = scanFrom;
        const sentence = SENTENCE_END.exec(buffer);
        if (sentence && sentence.index + sentence[0].length <= maxChunk)
          return sentence.index + sentence[0].length;
        if (
          buffer.length >= maxChunk ||
          (cuts === 0 && deltas >= FIRST_CHUNK_TOKENS)
        ) {
          const limit = Math.min(buffer.length, maxChunk);
          for (let i = limit - 1; i > 0; i--)
            if (SPACE.test(buffer[i]!)) return i;
          return limit;
        }
        let from = buffer.length;
        while (from > 0 && TRAILING_BOUNDARY.test(buffer[from - 1]!)) from--;
        scanFrom = from;
        return 0;
      };

      try {
        for (;;) {
          const next = await nextDelta();
          if (next === STOPPED) return;
          if (next === IDLE) {
            pushFailClosed();
            return;
          }
          if (next.done) break;
          read += next.value.length;
          turnRead += next.value.length;
          if (read > maxStream || turnRead > maxTurn) {
            if (turnRead > maxTurn) turnSpent = true;
            pushFailClosed();
            return;
          }
          buffer += next.value;
          deltas++;
          for (let end = cutEnd(); end > 0; end = cutEnd()) {
            const text = pendingWs + buffer.slice(0, end);
            buffer = buffer.slice(end);
            scanFrom = 0;
            deltas = 0;
            cuts++;
            if (text.trim() === '') {
              pendingWs = text;
              continue;
            }
            pendingWs = '';
            await awaitSlot();
            if (stopped) return;
            outstanding++;
            push(classify(text));
          }
        }
        const tail = pendingWs + buffer;
        if (tail.trim() !== '') {
          await awaitSlot();
          if (stopped) return;
          outstanding++;
          push(classify(tail));
        }
        push('end');
      } catch (error) {
        push({ error });
      }
    })();

    let held = '';
    try {
      for (;;) {
        while (queue.length === 0)
          await new Promise<void>((resolve) => (wakeConsumer = resolve));
        const item = queue.shift()!;
        if (item === 'end') {
          if (held) {
            approved.push(held);
            yield {
              kind: 'chunk',
              text: held,
              attempt,
              index: approved.length - 1,
            };
          }
          return 'done';
        }
        if ('error' in item) throw item.error;
        const verdict = await item.verdict;
        const decidedAtMs = now() - start;
        metrics.chunks.push({
          attempt,
          verdict: verdict.verdict,
          category: verdict.category,
          source: verdict.source,
          judgeLatencyMs: verdict.latencyMs,
          cutAtMs: item.cutAtMs,
          decidedAtMs,
        });
        if (verdict.verdict !== 'allow') return 'blocked';
        if (metrics.firstApprovedMs === null)
          metrics.firstApprovedMs = decidedAtMs;
        const pending = held + item.text;
        const cut = Math.max(0, pending.length - HOLD_BACK_CHARS);
        const emit = pending.slice(0, cut);
        held = pending.slice(cut);
        if (emit) {
          approved.push(emit);
          yield {
            kind: 'chunk',
            text: emit,
            attempt,
            index: approved.length - 1,
          };
        }
        releaseSlot();
      }
    } finally {
      stopped = true;
      wakeReaderNow();
      abort.abort();
      void it.return?.()?.catch(() => undefined);
    }
  }
}
