import { describe, expect, it, vi } from 'vitest';
import {
  SAFE_REDIRECT_TEMPLATE,
  runOutputGate,
  type GateEvent,
} from './outputGate.js';
import {
  JudgeModerator,
  type DeterministicLayer,
  type Moderator,
  type ModerationRequest,
  type Verdict,
} from './moderator.js';
import { hardFloorLayer } from './deterministicLayer.js';

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
        stream: () => tokens(...splitTokens(text)),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(chunkTexts(events).join('')).toBe(text);
  });

  it('classifies the first chunk after about 12 tokens without waiting for the sentence end', async () => {
    let pulled = 0;
    const release = deferred<void>();
    async function* source() {
      for (let i = 0; i < 12; i++) {
        pulled++;
        yield 'lengthy ';
      }
      await release.promise;
      yield 'more. ';
    }
    const { moderator } = scripted(() => ALLOW);
    const gen = runOutputGate({
      stream: () => source(),
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
      'lengthy '.repeat(12) + 'more.',
    );
  });
});

describe('ordering guarantees', () => {
  it('emits nothing before its verdict is allow', async () => {
    const verdict = deferred<Verdict>();
    const { moderator } = scripted(() => verdict.promise);
    const gen = runOutputGate({
      stream: () => tokens('Hello there. '),
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
      stream: () => tokens('One. ', 'Two. '),
      regenerate: () => {
        throw new Error('not expected');
      },
      moderator,
      tier: 'standard',
    });
    const pending = gen.next();
    await flush();
    first.resolve(ALLOW);
    expect((await pending).value).toMatchObject({ text: 'One. Two.' });
    expect((await gen.next()).value).toMatchObject({
      kind: 'end',
      outcome: 'approved',
    });
  });

  it('never emits a chunk from the blocked attempt after the block', async () => {
    const { moderator } = scripted((text) =>
      text.includes('Blocked') ? BLOCK : ALLOW,
    );
    const events = await collect(
      runOutputGate({
        stream: () =>
          tokens(
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
    expect(emitted).toEqual(['Regen one.']);
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
        stream: () => tokens('Bad start. '),
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

  it('block on chunk 3: keeps emitted prefix, regenerates from it, never shows the blocked chunk', async () => {
    const { moderator } = scripted((text) =>
      text.includes('Unsafe') ? BLOCK : ALLOW,
    );
    const calls: [number, string[]][] = [];
    const long = 'a'.repeat(80) + '. ';
    const events = await collect(
      runOutputGate({
        stream: () => tokens(long, 'Two. ', 'Unsafe three. ', 'Four. '),
        regenerate: (attempt, approved) => {
          calls.push([attempt, [...approved]]);
          return tokens('Safe three. ');
        },
        moderator,
        tier: 'standard',
      }),
    );
    expect(calls).toHaveLength(1);
    const prefix = calls[0]![1].join('');
    expect(prefix.length).toBeGreaterThan(0);
    expect(calls[0]![1]).toEqual(
      chunkTexts(
        events.slice(
          0,
          events.findIndex((e) => e.kind === 'regenerate'),
        ),
      ),
    );
    expect(chunkTexts(events).join('')).toBe(prefix + 'Safe three.');
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
        stream: () => tokens('Bad one. '),
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
        stream: () => tokens('Hello. '),
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
      stream: () => broken(),
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
    expect(chunkTexts(seen)).toEqual([]);
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
    const expected = sentences.join('').trimEnd();
    const events = await collect(
      runOutputGate({
        stream: () => tokens(...sentences),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxInFlight: 2,
      }),
    );
    expect(chunkTexts(events).join('')).toBe(expected);
    expect(peak).toBeLessThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
  });

  it('forced cuts keep every chunk within maxChunkChars and concatenate to the input', async () => {
    const phrase =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const text = [phrase, phrase, phrase].join(' ');
    const { moderator } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: () => tokens(...splitTokens(text, 4)),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxChunkChars: 64,
      }),
    );
    const chunks = chunkTexts(events);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(64);
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
        stream: () => source(),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'standard',
        maxStreamChars: 1_000_000,
        maxTurnChars: 1_000_000,
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
        stream: () => tokens(...Array.from({ length: 20 }, () => 'aaaa. ')),
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
        stream: () => tokens('Hi. ', '   ', 'There. '),
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
        stream: () => tokens('One. ', 'Two. '),
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
        stream: () => endless(),
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
        stream: () => tokens('One. ', 'Two. '),
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

const hungAfter = (
  first: string[],
  ret: () => Promise<IteratorResult<string>>,
) => ({
  [Symbol.asyncIterator]() {
    let n = 0;
    return {
      next: () =>
        n < first.length
          ? Promise.resolve({ value: first[n++]!, done: false })
          : new Promise<IteratorResult<string>>(() => undefined),
      return: ret,
    };
  },
});

describe('abandoned and hung upstreams', () => {
  it('a hung upstream is return()ed when its attempt is blocked', async () => {
    const ret = vi.fn(async () => ({ value: undefined, done: true as const }));
    const { moderator } = scripted((text) =>
      text.startsWith('Bad') ? BLOCK : ALLOW,
    );
    const events = await collect(
      runOutputGate({
        stream: () => hungAfter(['Bad. '], ret),
        regenerate: () => tokens('Fine. '),
        moderator,
        tier: 'family',
      }),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
    expect(ret).toHaveBeenCalledTimes(1);
  });

  it('a source that goes silent past sourceIdleMs fails closed into regenerate and return()s upstream', async () => {
    const ret = vi.fn(async () => ({ value: undefined, done: true as const }));
    const { moderator } = scripted(() => ALLOW);
    const seen = await collect(
      runOutputGate({
        stream: () => hungAfter(['Hi. '], ret),
        regenerate: () => tokens('x'),
        moderator,
        tier: 'family',
        sourceIdleMs: 20,
      }),
    );
    expect(chunkTexts(seen)).toEqual(['x']);
    expect(ret).toHaveBeenCalledTimes(1);
  });
});

describe('verdict bound', () => {
  it('a verdict that never resolves fails closed and regenerates', async () => {
    let calls = 0;
    const moderator: Moderator = {
      moderate: () => {
        calls++;
        return calls === 1
          ? new Promise<Verdict>(() => undefined)
          : Promise.resolve(ALLOW);
      },
    };
    const events = await collect(
      runOutputGate({
        stream: () => tokens('Hi. '),
        regenerate: () => tokens('Ok. '),
        moderator,
        tier: 'family',
        verdictTimeoutMs: 20,
      }),
    );
    expect(events.some((e) => e.kind === 'regenerate')).toBe(true);
    expect(chunkTexts(events)).toEqual(['Ok.']);
    const end = events.at(-1);
    if (end?.kind !== 'end') throw new Error('no end');
    expect(end.metrics.chunks[0]).toMatchObject({
      verdict: 'block',
      source: 'failclosed',
    });
  });
});

describe('per-turn ceiling', () => {
  it('stops regenerating once total read across attempts exceeds maxTurnChars', async () => {
    const { moderator } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: () => tokens('Fine. ', 'x'.repeat(60)),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'family',
        maxTurnChars: 50,
      }),
    );
    expect(events.some((e) => e.kind === 'regenerate')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'redirected' });
  });
});

describe('CJK sentence ends', () => {
  it('cuts after 。！？ without requiring a following space', async () => {
    const { moderator, seen } = scripted(() => ALLOW);
    const events = await collect(
      runOutputGate({
        stream: () => tokens('这是第一句。这是第二句！'),
        regenerate: () => {
          throw new Error('not expected');
        },
        moderator,
        tier: 'family',
      }),
    );
    expect(seen).toEqual(['这是第一句。', '这是第二句！']);
    expect(chunkTexts(events).join('')).toBe('这是第一句。这是第二句！');
  });
});

describe('deterministic window across forced cuts', () => {
  it('blocks a hard-floor term that straddles a forced 400-char cut before it is emitted whole', async () => {
    const deterministic: DeterministicLayer = {
      hardFloorCheck: (text) => ({
        blocked: text.includes('禁词'),
        category: 'sexual',
      }),
      denylistCheck: () => ({ blocked: false }),
      maxSpanChars: 2,
    };
    const moderator = new JudgeModerator({
      deterministic,
      chat: async () => '{"verdict":"allow","category":"none"}',
    });
    const events = await collect(
      runOutputGate({
        stream: () =>
          tokens('中'.repeat(399) + '禁词' + '中'.repeat(50) + '。'),
        regenerate: () => tokens('安全。'),
        moderator,
        tier: 'standard',
      }),
    );
    const out = chunkTexts(events).join('');
    expect(out).not.toContain('禁词');
    const end = events.at(-1);
    if (end?.kind !== 'end') throw new Error('no end');
    expect(end.metrics.chunks[1]).toMatchObject({
      verdict: 'block',
      source: 'hardfloor',
    });
  });
});

describe('turn-scoped hard floor across the carry', () => {
  it('blocks a message-level minor-plus-sexual violation whose minor reference is beyond the carry', async () => {
    const moderator = new JudgeModerator({
      deterministic: hardFloorLayer,
      chat: async () => '{"verdict":"allow","category":"none"}',
    });
    const filler = 'The tavern is quiet and the fire is low. '.repeat(30);
    const events = await collect(
      runOutputGate({
        stream: () =>
          tokens(
            ...splitTokens(
              `A child sleeps by the door. ${filler}Then nude.`,
              50,
            ),
          ),
        regenerate: () => tokens('The narrator pauses.'),
        moderator,
        tier: 'family',
      }),
    );
    expect(chunkTexts(events).join('')).not.toContain('nude');
    const end = events.at(-1);
    if (end?.kind !== 'end') throw new Error('no end');
    expect(end.metrics.chunks.filter((c) => c.verdict === 'block')).toEqual([
      expect.objectContaining({ attempt: 0, source: 'hardfloor' }),
    ]);
  });
});

describe('tail hold-back and config guards', () => {
  const ALLOW_JSON = async () => '{"verdict":"allow","category":"none"}';
  const termLayer = (term: string): DeterministicLayer => ({
    hardFloorCheck: (text) => ({
      blocked: text.includes(term),
      category: 'other',
    }),
    denylistCheck: () => ({ blocked: false }),
    maxSpanChars: term.length,
  });
  const runTerm = (
    term: string,
    parts: string[],
    extra: Partial<Parameters<typeof runOutputGate>[0]> = {},
  ) =>
    collect(
      runOutputGate({
        stream: () => tokens(...parts),
        regenerate: () => tokens('Safe.'),
        moderator: new JudgeModerator({
          deterministic: termLayer(term),
          chat: ALLOW_JSON,
        }),
        tier: 'standard',
        ...extra,
      }),
    );

  it('P1: a hard-floor term straddling a 400-char forced cut is never partly emitted', async () => {
    const events = await runTerm('禁词', [
      '中'.repeat(399) + '禁词' + '中'.repeat(50) + '。',
    ]);
    expect(chunkTexts(events).join('')).not.toContain('禁');
  });

  it('P2: a term straddling small forced cuts never leaks its prefix', async () => {
    const events = await runTerm(
      'abcdef',
      ['x'.repeat(62) + 'abcdef' + 'y'.repeat(100) + '.'],
      {
        maxChunkChars: 64,
      },
    );
    const out = chunkTexts(events).join('');
    expect(out).not.toContain('ab');
    expect(out).toBe('Safe.');
  });

  it('P4: maxChunkChars above the carry is refused at construction', () => {
    expect(() =>
      runOutputGate({
        stream: () => tokens('x.'),
        regenerate: () => tokens('y.'),
        moderator: new JudgeModerator({
          deterministic: termLayer('Q'),
          chat: ALLOW_JSON,
        }),
        tier: 'standard',
        maxChunkChars: 415,
      }),
    ).toThrow(/maxChunkChars/);
  });

  it('P9: a deterministic rule longer than the hold-back is refused at construction', () => {
    expect(
      () =>
        new JudgeModerator({
          deterministic: termLayer('Q'.repeat(900)),
          chat: ALLOW_JSON,
        }),
    ).toThrow(/span/);
  });

  it('P6: a silent source fails closed to the redirect path, not an exception to the consumer', async () => {
    const stream = (signal: AbortSignal) =>
      (async function* () {
        yield 'Hi. ';
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })();
    const events = await collect(
      runOutputGate({
        stream,
        regenerate: () => tokens('Safe.'),
        moderator: new JudgeModerator({
          deterministic: termLayer('nope'),
          chat: ALLOW_JSON,
        }),
        tier: 'standard',
        sourceIdleMs: 50,
      }),
    );
    expect(chunkTexts(events).join('')).toBe('Safe.');
    expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: 'approved' });
  });

  it('a first chunk of at least 64 chars emits everything but its held tail at its own verdict', async () => {
    const second = deferred<Verdict>();
    const { moderator } = scripted((text) =>
      text.startsWith(' b') ? second.promise : ALLOW,
    );
    const gen = runOutputGate({
      stream: () => tokens('a'.repeat(120) + '. ', 'b. '),
      regenerate: () => tokens('x'),
      moderator,
      tier: 'standard',
    });
    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: 'chunk', text: 'a'.repeat(57) });
    second.resolve(ALLOW);
    const rest = await collect(gen);
    expect(['a'.repeat(57), ...chunkTexts(rest)].join('')).toBe(
      'a'.repeat(120) + '. b.',
    );
  });

  it('a first chunk shorter than 64 chars is held until the next chunk passes', async () => {
    const second = deferred<Verdict>();
    const { moderator } = scripted((text) =>
      text.startsWith(' Yo') ? second.promise : ALLOW,
    );
    const gen = runOutputGate({
      stream: () => tokens('Hi. ', 'Yo. '),
      regenerate: () => tokens('x'),
      moderator,
      tier: 'standard',
    });
    let resolved = false;
    const pending = gen.next().then((r) => {
      resolved = true;
      return r;
    });
    await flush();
    expect(resolved).toBe(false);
    second.resolve(ALLOW);
    expect((await pending).value).toMatchObject({
      kind: 'chunk',
      text: 'Hi. Yo.',
    });
  });
});

describe('first-attempt abort', () => {
  it('aborts the first-attempt signal when the gate stops reading a hung upstream', async () => {
    let firstSignal: AbortSignal | undefined;
    async function* hungUntilAborted(signal: AbortSignal) {
      yield 'Hi. ';
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    }
    const { moderator } = scripted(() => ALLOW);
    await collect(
      runOutputGate({
        stream: (signal) => {
          firstSignal = signal;
          return hungUntilAborted(signal);
        },
        regenerate: () => tokens('x'),
        moderator,
        tier: 'family',
        sourceIdleMs: 20,
      }),
    );
    expect(firstSignal?.aborted).toBe(true);
  });
});

describe('unavailable verdict contract', () => {
  it('requires failClosedRow when unavailable is true', () => {
    // @ts-expect-error an unavailable verdict must name its fail-closed row
    const v: Verdict = {
      verdict: 'block',
      category: 'other',
      source: 'failclosed',
      latencyMs: 0,
      unavailable: true,
    };
    expect(v.unavailable).toBe(true);
  });
});
