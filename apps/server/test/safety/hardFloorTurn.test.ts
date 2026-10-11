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
  return { ...verdict, prefix: chunks.slice(0, blockedAt + 1).join('') };
}

/**
 * Contract: never under-block (a full-text block is a block here). An over-block is allowed
 * only where checkHardFloor already blocks the prefix up to the chunk that blocked, because
 * a streamed prefix can be sexual-looking before its completion ("harvest rapes" + "eed").
 * Rule labels may differ ("childporn" joined in a prefix, "childpornography" in full).
 */
function expectEquivalent(text: string, chunks: string[]) {
  const want = checkHardFloor(text);
  const got = runTurn(chunks);
  if (want.blocked) expect(got.blocked, 'under-block').toBe(true);
  if (got.blocked && !want.blocked)
    expect(checkHardFloor(got.prefix).blocked, 'over-block beyond prefix').toBe(
      true,
    );
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
  });

  it('keeps an early verdict sticky after the turn is blocked', () => {
    const turn = createHardFloorTurn();
    expect(turn.push('Mira is a child. ').blocked).toBe(false);
    expect(turn.push('She was raped.').blocked).toBe(true);
    expect(turn.push(' benign tail').blocked).toBe(true);
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

  const timeTurn = (text: string) => {
    const chunks = Array.from({ length: CHUNKS }, (_, i) =>
      text.slice(i * CHUNK, (i + 1) * CHUNK),
    );
    const turn = createHardFloorTurn();
    const t0 = performance.now();
    let verdict = { blocked: false, rule: undefined as string | undefined };
    for (const c of chunks) verdict = turn.push(c);
    return { ms: performance.now() - t0, blocked: verdict.blocked };
  };

  it.each([
    ['benign', sized(benign)],
    ['adversarial', sized(adversarial)],
  ] as const)(
    'scans a 30000-char turn in 75 chunks under 100 ms (%s)',
    (_name, text) => {
      expect(text.length).toBe(MAX_INPUT_CHARS);
      expect(checkHardFloor(text).blocked).toBe(false);
      timeTurn(text);
      const runs = Array.from({ length: 5 }, () => timeTurn(text));
      const median = runs.map((r) => r.ms).sort((a, b) => a - b)[2]!;
      console.log(
        `[perf] ${_name}: median ${median.toFixed(1)} ms over 5 runs ` +
          `(min ${Math.min(...runs.map((r) => r.ms)).toFixed(1)}, ` +
          `max ${Math.max(...runs.map((r) => r.ms)).toFixed(1)})`,
      );
      expect(runs.some((r) => r.blocked)).toBe(false);
      expect(median).toBeLessThan(100);
    },
  );
});
