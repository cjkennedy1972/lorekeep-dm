import { describe, expect, it } from 'vitest';
import {
  SAFE_REDIRECT_TEMPLATE,
  runOutputGate,
  type GateEvent,
} from './outputGate.js';
import type { Moderator, ModerationRequest, Verdict } from './moderator.js';

const ALLOW: Verdict = {
  verdict: 'allow',
  category: 'none',
  source: 'judge',
  latencyMs: 1,
  unavailable: false,
};
const BLOCK: Verdict = {
  verdict: 'block',
  category: 'violence',
  source: 'judge',
  latencyMs: 1,
  unavailable: false,
};

function scripted(
  decide: (text: string, n: number) => Promise<Verdict> | Verdict,
): {
  moderator: Moderator;
  seen: string[];
} {
  const seen: string[] = [];
  const moderator: Moderator = {
    moderate: async (req: ModerationRequest) => {
      seen.push(req.text);
      return decide(req.text, seen.length);
    },
  };
  return { moderator, seen };
}

async function* tokens(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

function splitTokens(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function collect(gen: AsyncGenerator<GateEvent>): Promise<GateEvent[]> {
  const events: GateEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const chunkTexts = (events: GateEvent[]) =>
  events.flatMap((e) => (e.kind === 'chunk' ? [e.text] : []));

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chunking', () => {
  it('splits on sentence boundaries and concatenates back to the exact input', async () => {
    const text =
      'The door creaks open. Inside, a 3.5 foot goblin waves! "Welcome," it says. The end';
    const { moderator } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: tokens(...splitTokens(text)),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(chunkTexts(events)).toEqual([
      'The door creaks open.',
      ' Inside, a 3.5 foot goblin waves!',
      ' "Welcome," it says.',
      ' The end',
    ]);
    expect(chunkTexts(events).join('')).toBe(text);
  });

  it('classifies the first chunk after about 12 tokens without waiting for the sentence end', async () => {
    let pulled = 0;
    const release = deferred<void>();
    async function* source() {
      for (let i = 0; i < 12; i++) {
        pulled++;
        yield 'word ';
      }
      await release.promise;
      yield 'more. ';
    }
    const { moderator } = scripted(() => ALLOW);
    const gen = runOutputGate({
      stream: source(),
      regenerate: () => {
        throw new Error('not expected');
      },
      moderator,
      tier: 'standard',
    });
    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: 'chunk' });
    expect(pulled).toBe(12);
    release.resolve();
    const rest = await collect(gen);
    expect(chunkTexts([first.value as GateEvent, ...rest]).join('')).toBe(
      'word '.repeat(12) + 'more.',
    );
  });
});

describe('ordering guarantees', () => {
  it('emits nothing before its verdict is allow', async () => {
    const verdict = deferred<Verdict>();
    const { moderator } = scripted(() => verdict.promise);
    const gen = runOutputGate({
      stream: tokens('Hello there. '),
      regenerate: () => {
        throw new Error('not expected');
      },
      moderator,
      tier: 'standard',
    });
    let emitted = 0;
    const pending = gen.next().then((r) => {
      emitted++;
      return r;
    });
    await flush();
    expect(emitted).toBe(0);
    verdict.resolve(ALLOW);
    expect((await pending).value).toMatchObject({
      kind: 'chunk',
      text: 'Hello there.',
    });
  });

  it('a later chunk whose verdict arrives first is still emitted after the earlier one', async () => {
    const first = deferred<Verdict>();
    const { moderator } = scripted((text) =>
      text.startsWith('One') ? first.promise : ALLOW,
    );
    const gen = runOutputGate({
      stream: tokens('One. ', 'Two. '),
      regenerate: () => {
        throw new Error('not expected');
      },
      moderator,
      tier: 'standard',
    });
    const pending = gen.next();
    await flush();
    first.resolve(ALLOW);
    expect((await pending).value).toMatchObject({ text: 'One.' });
    expect((await gen.next()).value).toMatchObject({ text: ' Two.' });
  });

  it('never emits a chunk from the blocked attempt after the block', async () => {
    const { moderator } = scripted((text) =>
      text.includes('Blocked') ? BLOCK : ALLOW,
    );
    const events = await collect(
      runOutputGate({
        stream: tokens(
          'Fine one. ',
          'Fine two. ',
          'Blocked three. ',
          'After four. ',
          'After five. ',
        ),
        regenerate: () => tokens('Regen one. '),
        moderator,
        tier: 'standard',
      }),
    );
    const emitted = chunkTexts(events);
    expect(emitted).toEqual(['Fine one.', ' Fine two.', 'Regen one.']);
    expect(emitted.join('')).not.toContain('Blocked');
    expect(emitted.join('')).not.toContain('After');
  });
});

describe('block and regenerate', () => {
  it('block on the first chunk: regenerate once with no approved prefix, then emit the approved retry', async () => {
    const { moderator } = scripted((text) =>
      text.startsWith('Bad') ? BLOCK : ALLOW,
    );
    const calls: [number, readonly string[]][] = [];
    const events = await collect(
      runOutputGate({
        stream: tokens('Bad start. '),
        regenerate: (attempt, approved) => {
          calls.push([attempt, [...approved]]);
          return tokens('Good start. ');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(calls).toEqual([[1, []]]);
    expect(chunkTexts(events)).toEqual(['Good start.']);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
  });

  it('block on chunk 3: keeps chunks 1-2, regenerates from them, never shows the blocked chunk', async () => {
    const { moderator } = scripted((text) =>
      text.includes('Unsafe') ? BLOCK : ALLOW,
    );
    const calls: [number, string[]][] = [];
    const events = await collect(
      runOutputGate({
        stream: tokens('One. ', 'Two. ', 'Unsafe three. ', 'Four. '),
        regenerate: (attempt, approved) => {
          calls.push([attempt, [...approved]]);
          return tokens('Safe three. ');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(calls).toEqual([[1, ['One.', ' Two.']]]);
    expect(chunkTexts(events)).toEqual(['One.', ' Two.', 'Safe three.']);
    expect(
      events.some((e) => e.kind === 'chunk' && e.text.includes('Unsafe')),
    ).toBe(false);
  });

  it('regenerate exhaustion: two regenerations then the fixed redirect template', async () => {
    const { moderator } = scripted((text) =>
      text.includes('Bad') ? BLOCK : ALLOW,
    );
    const calls: number[] = [];
    const events = await collect(
      runOutputGate({
        stream: tokens('Bad one. '),
        regenerate: (attempt) => {
          calls.push(attempt);
          return tokens(`Bad again ${attempt}. `);
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(calls).toEqual([1, 2]);
    expect(events.filter((e) => e.kind === 'regenerate')).toHaveLength(2);
    expect(events).toContainEqual({
      kind: 'redirect',
      text: SAFE_REDIRECT_TEMPLATE,
    });
    expect(chunkTexts(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'redirected' });
  });

  it('a moderator that throws counts as a block', async () => {
    const moderator: Moderator = {
      moderate: async () => {
        throw new Error('boom');
      },
    };
    const calls: number[] = [];
    const events = await collect(
      runOutputGate({
        stream: tokens('Hello. '),
        regenerate: (attempt) => {
          calls.push(attempt);
          return tokens('Hi. ');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(calls).toEqual([1, 2]);
    expect(events).toContainEqual({
      kind: 'redirect',
      text: SAFE_REDIRECT_TEMPLATE,
    });
    expect(chunkTexts(events)).toEqual([]);
  });

  it('a source error stops emission and propagates', async () => {
    const { moderator } = scripted(() => ALLOW);
    async function* broken() {
      yield 'Solid first. ';
      throw new Error('stream reset');
    }
    const gen = runOutputGate({
      stream: broken(),
      regenerate: () => {
        throw new Error('not expected');
      },
      moderator,
      tier: 'standard',
    });
    const seen: GateEvent[] = [];
    await expect(
      (async () => {
        for await (const e of gen) seen.push(e);
      })(),
    ).rejects.toThrow('stream reset');
    expect(chunkTexts(seen)).toEqual(['Solid first.']);
  });
});

describe('bounded judging and buffering', () => {
  it('never has more judge calls in flight than maxInFlight across 500 sentences', async () => {
    let inFlight = 0;
    let peak = 0;
    const moderator: Moderator = {
      moderate: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await flush();
        inFlight--;
        return ALLOW;
      },
    };
    const sentences = Array.from({ length: 500 }, (_, i) => `S${i}. `);
    const events = await collect(
      runOutputGate({
        stream: tokens(...sentences),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxInFlight: 2,
      }),
    );
    expect(chunkTexts(events)).toHaveLength(500);
    expect(peak).toBeLessThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
  });

  it('forced cuts keep every chunk within maxChunkChars and concatenate to the input', async () => {
    const text =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const { moderator } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: tokens(...splitTokens(text, 4)),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxChunkChars: 12,
      }),
    );
    const chunks = chunkTexts(events);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
    expect(chunks.join('')).toBe(text);
  });

  it('a 200k-delta run with no sentence end stays bounded and reassembles exactly', async () => {
    const deltas = 200_000;
    const text =
      Array.from({ length: deltas - 5 }, (_, i) =>
        i % 50 === 49 ? '. ' : 'x',
      ).join('') + 'done.';
    async function* source() {
      for (let i = 0; i < text.length; i++) yield text[i]!;
    }
    const { moderator } = scripted(() => ALLOW);
    const started = performance.now();
    const events = await collect(
      runOutputGate({
        stream: source(),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxStreamChars: 1_000_000,
      }),
    );
    const elapsedMs = performance.now() - started;
    const chunks = chunkTexts(events);
    expect(chunks.join('')).toBe(text);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(400);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
    console.info(
      `200k-delta gate run: ${elapsedMs.toFixed(0)} ms, ${chunks.length} chunks`,
    );
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('exceeding maxStreamChars fails closed and regenerates', async () => {
    const { moderator } = scripted(() => ALLOW);
    const calls: number[] = [];
    const events = await collect(
      runOutputGate({
        stream: tokens(...Array.from({ length: 20 }, () => 'aaaa. ')),
        regenerate: (attempt) => {
          calls.push(attempt);
          return tokens('Calm. ');
        },
        moderator,
        tier: 'standard',
        maxStreamChars: 50,
      }),
    );
    expect(calls).toEqual([1]);
    expect(chunkTexts(events).at(-1)).toBe('Calm.');
    const end = events.at(-1);
    if (end?.kind !== 'end') throw new Error('no end');
    expect(end.metrics.chunks.find((c) => c.verdict === 'block')).toMatchObject(
      {
        attempt: 0,
        verdict: 'block',
        source: 'failclosed',
      },
    );
  });

  it('whitespace-only runs are never sent to the moderator', async () => {
    const { moderator, seen } = scripted(() => ALLOW);
    await collect(
      runOutputGate({
        stream: tokens('Hi. ', '   ', 'There. '),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(seen.every((t) => t.trim() !== '')).toBe(true);
  });

  it('passes the previous chunk as context and the verdict text alone', async () => {
    const contexts: Array<string | undefined> = [];
    const moderator: Moderator = {
      moderate: async (req: ModerationRequest) => {
        contexts.push(req.context);
        return ALLOW;
      },
    };
    await collect(
      runOutputGate({
        stream: tokens('One. ', 'Two. '),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(contexts).toEqual(['', 'One.']);
  });

  it('a blocked attempt aborts its upstream and its regenerate signal once it is abandoned', async () => {
    let upstreamClosed = false;
    async function* endless() {
      try {
        for (;;) yield 'Bad. ';
      } finally {
        upstreamClosed = true;
      }
    }
    const { moderator } = scripted((text) =>
      text.startsWith('Bad') ? BLOCK : ALLOW,
    );
    let signal: AbortSignal | undefined;
    const events = await collect(
      runOutputGate({
        stream: endless(),
        regenerate: (_attempt, _approved, s) => {
          signal = s;
          return tokens('Good. ');
        },
        moderator,
        tier: 'standard',
        maxInFlight: 1,
      }),
    );
    await flush();
    expect(chunkTexts(events)).toEqual(['Good.']);
    expect(upstreamClosed).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

describe('metrics', () => {
  it('reports time to first approved chunk and per-chunk verdict records', async () => {
    const { moderator } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: tokens('One. ', 'Two. '),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'family',
      }),
    );
    const end = events.at(-1);
    expect(end).toMatchObject({ kind: 'end', outcome: 'approved' });
    if (end?.kind !== 'end') throw new Error('no end');
    expect(end.metrics.firstApprovedMs).toBeTypeOf('number');
    expect(end.metrics.regenerations).toBe(0);
    expect(
      end.metrics.chunks.map((c) => [c.attempt, c.verdict, c.source]),
    ).toEqual([
      [0, 'allow', 'judge'],
      [0, 'allow', 'judge'],
    ]);
  });
});
