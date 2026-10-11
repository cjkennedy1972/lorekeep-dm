import { describe, expect, it } from 'vitest';
import { checkHardFloor, MAX_INPUT_CHARS } from './hardFloor.js';
import { hardFloorLayer } from './deterministicLayer.js';
import { JudgeModerator } from './moderator.js';
import { DEFAULT_MAX_TURN_CHARS } from './outputGate.js';
import { MAX_RULE_SPAN_CHARS } from './moderator.js';

const gap = (n: number) => ' '.repeat(Math.max(1, n));

/** One witness per hard-floor match family; each blocks for any gap length. */
const WITNESSES: Record<string, (n: number) => string> = {
  'explicit term, pieces split by a space run': (n) => `l${gap(n)}o l i`,
  'minor noun then sexual term, gap of n spaces': (n) => `child${gap(n)}nude`,
  'youth prefix and noun, then sexual term': (n) =>
    `young${gap(n)}girl${gap(n)}nude`,
  'spaced letters of a minor word, then sexual term': (n) =>
    `c${gap(n)}h${gap(n)}i${gap(n)}l${gap(n)}d${gap(n)}nude`,
  'minor word, then "have sex" phrase': (n) => `child${gap(n)}have sex`,
  'dotted letters of a minor word, then sexual term': (n) =>
    `c.h.i.l.d${gap(n)}nude`,
};

describe('hard-floor match spans are unbounded', () => {
  for (const [family, witness] of Object.entries(WITNESSES)) {
    it(`${family}: still blocks past MAX_RULE_SPAN_CHARS`, () => {
      for (const n of [
        0,
        MAX_RULE_SPAN_CHARS,
        MAX_RULE_SPAN_CHARS + 1,
        5_000,
      ]) {
        expect(checkHardFloor(witness(n)).blocked, `gap ${n}`).toBe(true);
      }
    });
  }

  it('the adapter declares no bounded span, so the hold-back does not claim this layer', () => {
    expect(hardFloorLayer.maxSpanChars).toBe(0);
  });
});

describe('hard-floor adapter', () => {
  it('reports the hard-floor verdict through the deterministic seam', () => {
    expect(hardFloorLayer.hardFloorCheck('the baby dragon sleeps')).toEqual({
      blocked: false,
    });
    expect(hardFloorLayer.hardFloorCheck(`child${gap(10)}nude`).blocked).toBe(
      true,
    );
    expect(hardFloorLayer.denylistCheck('anything').blocked).toBe(false);
  });
});

describe('turn-scoped evaluation', () => {
  const ALLOW = async () => '{"verdict":"allow","category":"none"}';

  it('the 400-char carry alone misses a minor reference further back than the carry', async () => {
    const moderator = new JudgeModerator({
      deterministic: hardFloorLayer,
      chat: ALLOW,
    });
    const verdict = await moderator.moderate({
      text: 'nude',
      context: 'x'.repeat(400),
      tier: 'family',
      direction: 'output',
    });
    expect(verdict.verdict).toBe('allow');
  });

  it('the turn scanner catches the same message-level violation', async () => {
    const moderator = new JudgeModerator({
      deterministic: hardFloorLayer,
      chat: ALLOW,
    });
    const turn = moderator.startTurn()!;
    turn.push(`A child sleeps. ${'x '.repeat(500)}`);
    const verdict = await moderator.moderate({
      text: 'nude',
      context: 'x'.repeat(400),
      turn,
      tier: 'family',
      direction: 'output',
    });
    expect(verdict).toMatchObject({ verdict: 'block', source: 'hardfloor' });
  });

  it('input cap covers the output turn cap', () => {
    expect(MAX_INPUT_CHARS).toBeGreaterThanOrEqual(DEFAULT_MAX_TURN_CHARS);
  });

  it('a full 30,000-char turn scans within the 100 ms budget', () => {
    const turn = `${'The tavern is quiet and the fire is low. '.repeat(
      Math.ceil(DEFAULT_MAX_TURN_CHARS / 43),
    )}`.slice(0, DEFAULT_MAX_TURN_CHARS);
    checkHardFloor(turn);
    const start = performance.now();
    expect(checkHardFloor(turn).blocked).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
