import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_CHARS,
  checkHardFloor,
  createHardFloorTurn,
} from '../../src/safety/hardFloor.js';
import {
  HARD_FLOOR_NEGATIVE,
  HARD_FLOOR_POSITIVE,
} from '../fixtures/hard-floor-fixtures.js';
import { medianMs } from '../fixtures/timing.js';

const ABSOLUTE_CEILING_MS = 500;

const isLowSurrogate = (text: string, i: number) =>
  i > 0 && i < text.length && /[\uDC00-\uDFFF]/.test(text[i]!);

function splitAt(text: string, cuts: number[]): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const c of [...cuts, text.length]) {
    out.push(text.slice(prev, c));
    prev = c;
  }
  return out;
}

function runTurn(chunks: string[]) {
  const turn = createHardFloorTurn();
  let verdict = { blocked: false, rule: undefined as string | undefined };
  let blockedAt = -1;
  chunks.forEach((c, i) => {
    verdict = turn.push(c);
    if (verdict.blocked && blockedAt < 0) blockedAt = i;
  });
  if (blockedAt < 0) {
    verdict = turn.finish();
    if (verdict.blocked) blockedAt = chunks.length - 1;
  }
  return { ...verdict, prefix: chunks.slice(0, blockedAt + 1).join('') };
}

/**
 * Contract: never under-block (a full-text block is a block here). An over-block is allowed
 * only where checkHardFloor already blocks the prefix up to the chunk that blocked, because
 * a streamed prefix can be sexual-looking before its completion ("harvest rapes" + "eed").
 * Rule labels may differ ("childporn" joined in a prefix, "childpornography" in full).
 */
function expectEquivalent(text: string, chunks: string[], label = '') {
  const want = checkHardFloor(text);
  const got = runTurn(chunks);
  if (want.blocked) expect(got.blocked, `under-block ${label}`).toBe(true);
  if (got.blocked && !want.blocked)
    expect(
      checkHardFloor(got.prefix).blocked,
      `over-block beyond prefix ${label}: ${JSON.stringify({ text, prefix: got.prefix })}`,
    ).toBe(true);
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCuts(text: string, rand: () => number): number[] {
  const n = 1 + Math.floor(rand() * 7);
  const cuts = new Set<number>();
  for (let i = 0; i < n; i++) {
    const k = 1 + Math.floor(rand() * Math.max(1, text.length - 1));
    if (k < text.length && !isLowSurrogate(text, k)) cuts.add(k);
  }
  return [...cuts].sort((a, b) => a - b);
}

const FIXTURES = [...HARD_FLOOR_POSITIVE, ...HARD_FLOOR_NEGATIVE];

describe('createHardFloorTurn equivalence', () => {
  it.each(FIXTURES.map((f) => [f.id, f.text] as const))(
    'agrees with checkHardFloor on every two-way split of %s',
    (_id, text) => {
      for (let k = 1; k < text.length; k++) {
        if (isLowSurrogate(text, k)) continue;
        expectEquivalent(text, splitAt(text, [k]));
      }
    },
  );

  it.each(FIXTURES.map((f) => [f.id, f.text] as const))(
    'agrees with checkHardFloor on random multi-chunk splits of %s',
    (_id, text) => {
      const rand = mulberry32(text.length * 7919 + 1);
      for (let trial = 0; trial < 12; trial++)
        expectEquivalent(text, splitAt(text, randomCuts(text, rand)));
    },
  );

  it('defers tentative youth tail until the adult marker is settled, then allows the turn', () => {
    const turn = createHardFloorTurn();
    const first = turn.push('She had sex. The youth');
    expect(first.blocked).toBe(false);
    expect(first.sensitive).toBe(true);

    const second = turn.push(' adult hung back.');
    expect(second.blocked).toBe(false);
    expect(turn.finish().blocked).toBe(false);
    expect(
      checkHardFloor('She had sex. The youth adult hung back.').blocked,
    ).toBe(false);
  });

  it('still applies a tentative youth tail at end of turn', () => {
    const turn = createHardFloorTurn();
    expect(turn.push('She had sex. The youth').blocked).toBe(false);
    expect(turn.finish().blocked).toBe(true);
  });

  it('blocks when a minor reference and a sexual term are more than the carry apart', () => {
    const filler = 'The caravan crossed the dunes under a pale sky. '.repeat(
      40,
    );
    const text = `Mira is a child. ${filler}She was raped at dusk.`;
    expect(checkHardFloor(text).blocked).toBe(true);
    const chunks = Array.from(
      { length: Math.ceil(text.length / 400) },
      (_, i) => text.slice(i * 400, (i + 1) * 400),
    );
    expect(runTurn(chunks).blocked).toBe(true);
    expectEquivalent(text, chunks);
  });

  it('uses the shared bounded separator canonicalizer in both full and streamed scans', () => {
    const text = `The child${'. '.repeat(600)}was nude.`;
    const full = checkHardFloor(text);
    const turn = createHardFloorTurn();
    let streamed = { blocked: false };
    for (let i = 0; i < text.length; i += 37)
      streamed = turn.push(text.slice(i, i + 37));
    streamed = turn.finish();
    expect(full.blocked).toBe(true);
    expect(streamed.blocked).toBe(full.blocked);
  });

  it('records the intentional over-block when separator compaction creates a 3-mark age cue', () => {
    // NAME_AGE accepts up to three punctuation marks. Compaction shortens this four-mark
    // run to three, so the shared full/stream canonical form treats it as an age cue.
    const text = 'Mira....12. She was raped.';
    expect(checkHardFloor(text).blocked).toBe(true);
    expectEquivalent(text, chunksOf(text, 1));
  });

  it('preserves the full-scan verdict across seeded separator and carry boundaries', () => {
    const separators = [
      ' ',
      '. '.repeat(80),
      '!?,'.repeat(50),
      '\u200b'.repeat(120),
      '\t'.repeat(200),
      '—'.repeat(80),
      ' _ '.repeat(60),
    ];
    const rand = mulberry32(0x08c2026);
    for (let trial = 0; trial < 24; trial++) {
      const gap = separators[Math.floor(rand() * separators.length)]!;
      const text =
        trial % 2 === 0
          ? `Mira is a child${gap}She was raped.`
          : `She was raped${gap}Mira is a child.`;
      // Separator canonicalization has intentional semantic deltas; the stream must
      // match the canonical full scan (or only over-block at a blocking prefix).
      for (const size of [1, 10, 37, 400])
        expectEquivalent(
          text,
          chunksOf(text, size),
          `trial=${trial},size=${size}`,
        );
      expectEquivalent(
        text,
        splitAt(text, randomCuts(text, rand)),
        `trial=${trial},random`,
      );
    }
  });

  it('keeps sensitive visibility sticky without turning a merged token into a verdict', () => {
    const turn = createHardFloorTurn();
    const first = turn.push('She was raped');
    expect(first.sensitive).toBe(true);
    expect(first.blocked).toBe(false);

    const pushed = turn.push(`${'\u200b'.repeat(120)}Mira is a child.`);
    const final = turn.finish();
    expect(pushed.sensitive).toBe(true);
    expect(final.sensitive).toBe(true);
    expect(checkHardFloor('She was rapedMira is a child.').blocked).toBe(false);
    expect(final.blocked).toBe(false);
  });

  it('keeps an early verdict sticky after the turn is blocked', () => {
    const turn = createHardFloorTurn();
    expect(turn.push('Mira is a child. ').blocked).toBe(false);
    expect(turn.push('She was raped.').blocked).toBe(false);
    expect(turn.finish().blocked).toBe(true);
    expect(turn.finish().blocked).toBe(true);
  });

  it('blocks a turn longer than MAX_INPUT_CHARS like checkHardFloor does', () => {
    const text = 'a'.repeat(MAX_INPUT_CHARS + 1);
    expect(checkHardFloor(text).rule).toBe('input.over-limit');
    const chunks = Array.from({ length: 76 }, (_, i) =>
      text.slice(i * 400, (i + 1) * 400),
    );
    expect(runTurn(chunks).rule).toBe('input.over-limit');
  });
});

const chunksOf = (text: string, size: number) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const PROSE =
  'The old keep stood on the hill above the river, and the men of the village ran down to the market to sell bread and ale. ';

const GAP_CASES: [string, string][] = [
  ['minor, hyphen run, sexual', `The child ${'-'.repeat(600)}nude`],
  ['minor, space run, sexual', `The child ${' '.repeat(600)}nude`],
  ['minor, CJK run, sexual', `The child ${'漢'.repeat(450)} nude`],
  ['minor, prose run, sexual', `The child ${PROSE.repeat(10)}she was nude`],
  ['sexual, hyphen run, minor', `She was naked ${'-'.repeat(600)}child`],
  ['minor, 400 hyphens, sexual', `The child ${'-'.repeat(400)}nude`],
  ['minor, 200 hyphens, sexual', `The child ${'-'.repeat(200)}nude`],
  ['minor, one 450-char token, sexual', `child ${'a'.repeat(450)} nude`],
  ['NAME_AGE, 600 spaces, sexual', `Mira 12${' '.repeat(600)}nude`],
  ['sexual anchor before NAME_AGE', 'Naked, 12, is.'],
];

const GAP_FILLERS = ['-', ' ', '漢', 'the '];

/** Minor-then-sexual and sexual-then-minor texts with a filler of exactly `gap` characters. */
function orderedGapTexts(gap: number): string[] {
  return GAP_FILLERS.flatMap((f) => {
    const mid = f.repeat(Math.ceil(gap / f.length)).slice(0, gap);
    return [`The child ${mid}nude`, `She was naked ${mid}child`];
  });
}

describe('streamed gap under-block (B1)', () => {
  it('preserves a sexual term used as the NAME_AGE anchor', () => {
    const text = 'Naked, 12, is.';
    expect(checkHardFloor(text).blocked).toBe(true);
    expect(runTurn(chunksOf(text, 1)).blocked).toBe(true);
  });

  it('folds astral format characters across the one-character fast path boundary', () => {
    const turn = createHardFloorTurn();
    expect(turn.push(`se\u{E0001}`).blocked).toBe(false);
    expect(turn.push('x').blocked).toBe(false);
    expect(turn.push(' ').blocked).toBe(false);
    expect(turn.push('child').blocked).toBe(false);
    expect(turn.finish().blocked).toBe(true);
    expect(checkHardFloor(`se\u{E0001}x child`).blocked).toBe(true);
  });

  it.each(GAP_CASES)(
    'blocks when a minor term and a sexual term are far apart: %s',
    (_name, text) => {
      expect(checkHardFloor(text).blocked).toBe(true);
      for (const size of [50, 97, 400])
        expect(runTurn(chunksOf(text, size)).blocked, `chunk ${size}`).toBe(
          true,
        );
    },
  );

  it.each(GAP_CASES)('agrees on every two-way split: %s', (_name, text) => {
    for (let k = 1; k < text.length; k++) {
      if (isLowSurrogate(text, k)) continue;
      expectEquivalent(text, splitAt(text, [k]));
    }
  });

  it('400-fuzz: random multi-chunk splits for gaps of 396 to 404 characters', () => {
    const rand = mulberry32(400);
    for (let gap = 396; gap <= 404; gap++)
      for (const text of orderedGapTexts(gap))
        for (let trial = 0; trial < 12; trial++)
          expectEquivalent(text, splitAt(text, randomCuts(text, rand)));
  });

  it('388 boundary-adversarial: every two-way split of gaps at the 388 carry edge', () => {
    for (const text of orderedGapTexts(388))
      for (let k = 1; k < text.length; k++) {
        if (isLowSurrogate(text, k)) continue;
        expectEquivalent(text, splitAt(text, [k]));
      }
  });
});

describe('createHardFloorTurn perf', () => {
  const CHUNK = 400;
  const CHUNKS = 75;
  const benign =
    'The tavern was loud and the ale was cold; the bard sang of dragons and gold. ';
  const adversarial =
    'the child 1 1 1 1 12 xiv 0 0 0 w0rd 1i 1l ii iii 3x3rc1s3 ii 1 2 3 4 5 6 ';

  const sized = (unit: string) =>
    unit
      .repeat(Math.ceil((CHUNK * CHUNKS) / unit.length))
      .slice(0, CHUNK * CHUNKS);

  const sparseTail = (
    'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 ' +
    '-'.repeat(MAX_INPUT_CHARS)
  ).slice(0, MAX_INPUT_CHARS);

  const scanTurn = (text: string) => {
    const size = Math.ceil(text.length / CHUNKS);
    const turn = createHardFloorTurn();
    let verdict = { blocked: false, rule: undefined as string | undefined };
    for (let i = 0; i < CHUNKS; i++)
      verdict = turn.push(text.slice(i * size, (i + 1) * size));
    return turn.finish().blocked;
  };

  it.each([
    ['benign', sized(benign)],
    ['adversarial', sized(adversarial)],
    ['sparse: one token', 'a'.repeat(MAX_INPUT_CHARS)],
    ['sparse: 23 tokens then separators', sparseTail],
  ] as const)(
    'scans a 30000-char turn in 75 chunks in linear time (%s)',
    (_name, text) => {
      expect(text.length).toBe(MAX_INPUT_CHARS);
      expect(checkHardFloor(text).blocked).toBe(false);
      expect(scanTurn(text)).toBe(false);
      const full = medianMs(() => scanTurn(text), 11);
      const half = medianMs(
        () => scanTurn(text.slice(0, MAX_INPUT_CHARS / 2)),
        11,
      );
      expect(full / half, 'scaling').toBeLessThan(3);
      expect(full, '100 ms 75-chunk acceptance target').toBeLessThan(100);
      expect(full, 'absolute safety ceiling').toBeLessThan(ABSOLUTE_CEILING_MS);
    },
  );

  it('records adversarial 30000-char scan timings at 1/10/400-char chunk sizes', () => {
    const text = sized(adversarial);
    const run = (s: string, chunkSize: number) => {
      const turn = createHardFloorTurn();
      const start = performance.now();
      let verdict = { blocked: false };
      for (let i = 0; i < s.length; i += chunkSize)
        verdict = turn.push(s.slice(i, i + chunkSize));
      verdict = turn.finish();
      expect(verdict.blocked).toBe(false);
      return performance.now() - start;
    };
    expect(text.length).toBe(MAX_INPUT_CHARS);
    expect(checkHardFloor(text).blocked).toBe(false);
    const half = medianMs(() => run(text.slice(0, MAX_INPUT_CHARS / 2), 1));
    const full = medianMs(() => run(text, 1));
    const tenChar = medianMs(() => run(text, 10));
    const fourHundredChar = medianMs(() => run(text, 400));
    console.info(
      `30k adversarial push timing: 1-char=${full.toFixed(1)}ms, 10-char=${tenChar.toFixed(1)}ms, 400-char=${fourHundredChar.toFixed(1)}ms`,
    );
    expect(full / half, 'scaling').toBeLessThan(3);
    // Keep the pathological one-character stress case useful without making this
    // wall-clock assertion flaky when the full suite runs other workers concurrently.
    expect(full, 'one-character stress ceiling').toBeLessThan(120);
    expect(tenChar, '100 ms 10-character target').toBeLessThan(100);
    expect(fourHundredChar, '100 ms 400-character target').toBeLessThan(100);
  }, 60_000);
});
