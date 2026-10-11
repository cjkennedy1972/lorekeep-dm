import type { ContentTier } from './tier.js';
import type { Category, Moderator, Verdict } from './moderator.js';

export const SAFE_REDIRECT_TEMPLATE =
  'The narrator pauses, and the scene turns to the next thing the party notices.';

export const MAX_REGENERATIONS = 2;
const FIRST_CHUNK_TOKENS = 12;
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g;

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
  /** Narration deltas for the first attempt. */
  stream: AsyncIterable<string>;
  /** Caller owns the LLM call. Receives the approved prefix so a retry continues it. */
  regenerate: (
    attempt: number,
    approved: readonly string[],
  ) => AsyncIterable<string>;
  moderator: Moderator;
  tier: ContentTier;
  tableLines?: readonly string[];
  now?: () => number;
}

type Inflight = { text: string; verdict: Promise<Verdict>; cutAtMs: number };
type Item = Inflight | 'end' | { error: unknown };

/** Returns the end index of the first ready cut, or 0 when nothing is ready. */
function findCut(buffer: string, firstChunk: boolean, deltas: number): number {
  SENTENCE_END.lastIndex = 0;
  const sentence = SENTENCE_END.exec(buffer);
  if (sentence) return sentence.index + sentence[0].length;
  if (firstChunk && deltas >= FIRST_CHUNK_TOKENS) {
    const space = Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf('\n'));
    return space > 0 ? space : buffer.length;
  }
  return 0;
}

function failClosed(latencyMs: number): Verdict {
  return {
    verdict: 'block',
    category: 'other',
    source: 'failclosed',
    latencyMs,
    unavailable: true,
  };
}

export async function* runOutputGate(
  opts: OutputGateOptions,
): AsyncGenerator<GateEvent> {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  const metrics: GateMetrics = {
    firstApprovedMs: null,
    regenerations: 0,
    chunks: [],
  };
  const approved: string[] = [];

  for (let attempt = 0; ; attempt++) {
    let source = opts.stream;
    if (attempt > 0) {
      metrics.regenerations = attempt;
      yield { kind: 'regenerate', attempt };
      source = opts.regenerate(attempt, [...approved]);
    }
    const outcome = yield* runAttempt(source, attempt);
    if (outcome === 'done') {
      return yield { kind: 'end', outcome: 'approved', metrics };
    }
    if (attempt === MAX_REGENERATIONS) {
      yield { kind: 'redirect', text: SAFE_REDIRECT_TEMPLATE };
      return yield { kind: 'end', outcome: 'redirected', metrics };
    }
  }

  async function* runAttempt(
    source: AsyncIterable<string>,
    attempt: number,
  ): AsyncGenerator<GateEvent, 'done' | 'blocked', undefined> {
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    const push = (item: Item) => {
      queue.push(item);
      const notify = wake;
      wake = null;
      notify?.();
    };
    let stopped = false;

    const classify = (text: string): Inflight => {
      const cutAtMs = now() - start;
      const verdict = Promise.resolve()
        .then(() =>
          opts.moderator.moderate({
            text,
            tier: opts.tier,
            tableLines: opts.tableLines,
            direction: 'output',
          }),
        )
        .catch(() => failClosed(now() - start - cutAtMs));
      return { text, verdict, cutAtMs };
    };

    void (async () => {
      try {
        let buffer = '';
        let deltas = 0;
        let cuts = 0;
        for await (const delta of source) {
          if (stopped) return;
          buffer += delta;
          deltas++;
          let end = findCut(buffer, cuts === 0, deltas);
          while (end > 0) {
            push(classify(buffer.slice(0, end)));
            buffer = buffer.slice(end);
            cuts++;
            deltas = 0;
            end = findCut(buffer, false, 0);
          }
        }
        if (buffer.trim().length > 0) push(classify(buffer));
        push('end');
      } catch (error) {
        push({ error });
      }
    })();

    try {
      for (;;) {
        while (queue.length === 0)
          await new Promise<void>((resolve) => (wake = resolve));
        const item = queue.shift()!;
        if (item === 'end') return 'done';
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
        approved.push(item.text);
        yield {
          kind: 'chunk',
          text: item.text,
          attempt,
          index: approved.length - 1,
        };
      }
    } finally {
      stopped = true;
    }
  }
}
