import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EndpointProfile } from '../../src/llm/probe.js';
import {
  THRESHOLDS,
  isQualified,
  withQualification,
  type EvalRecordLike,
} from '../../src/llm/qualification.js';

const profile = (over: Partial<EndpointProfile> = {}): EndpointProfile => ({
  id: 'ep-1',
  model: 'm',
  toolMode: 'native',
  capabilities: {} as EndpointProfile['capabilities'],
  validCallRate: 1,
  schemaViolations: 0,
  ttftMs: 10,
  contextWindow: 32768,
  qualified: false,
  probedAt: '2026-10-09T00:00:00.000Z',
  ...over,
});
const record = (
  over: Partial<EvalRecordLike> = {},
  rules = 0.95,
): EvalRecordLike => ({
  mode: 'live',
  endpointProfileId: 'ep-1',
  suites: {
    rules: { score: rules, n: 50 },
    puppeting: { score: 0, n: 50 },
    mapContradiction: { score: 0, n: 30 },
    toolValidity: { score: 1, n: 20 },
  },
  ...over,
});

describe('endpoint qualification', () => {
  it('stays false with no record', () => {
    expect(isQualified(profile(), [])).toBe(false);
  });
  it('stays false for a failing record', () => {
    expect(isQualified(profile(), [record({}, 0.89)])).toBe(false);
    const bad = record();
    bad.suites.puppeting.score = 0.02; // threshold is exclusive: < 2%
    expect(isQualified(profile(), [bad])).toBe(false);
  });
  it('is true only for a passing live record for the same profile id', () => {
    expect(isQualified(profile(), [record()])).toBe(true);
    expect(
      isQualified(profile(), [record({ endpointProfileId: 'other' })]),
    ).toBe(false);
    expect(isQualified(profile(), [record({ mode: 'recorded' })])).toBe(false);
  });
  it('uses the latest live record, and never an unsupported tool mode', () => {
    expect(isQualified(profile(), [record(), record({}, 0.5)])).toBe(false);
    expect(isQualified(profile({ toolMode: 'unsupported' }), [record()])).toBe(
      false,
    );
  });
  it('rejects malformed scores instead of trusting a passed flag', () => {
    const r = record({}, Number.NaN);
    expect(
      isQualified(profile(), [{ ...r, passed: true } as EvalRecordLike]),
    ).toBe(false);
  });
  it('withQualification flips the flag on the profile', () => {
    expect(withQualification(profile(), [record()]).qualified).toBe(true);
    expect(withQualification(profile(), []).qualified).toBe(false);
  });
  it('thresholds match packages/evals/data/thresholds.json', () => {
    const file = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/evals/data/thresholds.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(THRESHOLDS).toEqual(file);
  });
});
