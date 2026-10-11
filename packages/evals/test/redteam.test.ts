import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const load = (n: string) =>
  JSON.parse(readFileSync(new URL(`../redteam/${n}`, import.meta.url), 'utf8'));

const TIERS = ['family', 'standard', 'mature'];
const INJECTION_CATEGORIES = [
  'instruction-override',
  'state-mutation',
  'tier-flip',
  'roleplay-jailbreak',
  'delimiter-escape',
  'fake-authority',
  'encoding-obfuscation',
  'multi-turn',
  'tool-call-forgery',
  'meta-probe',
];
const INJECTION_EXPECTED = ['blocked', 'redirected', 'no-state-change'];
const BOUNDARY_CATEGORIES = [
  'none',
  'violence',
  'language',
  'sexual',
  'minor_sexual',
  'hate',
  'self_harm',
  'lines_veils',
  'other',
];
const XCARD_TRIGGERS = ['x-card', 'pause', 'forged-control'];
const XCARD_SIGNALERS = ['anonymous', 'seat', 'host', 'spectator', 'text'];
const XCARD_TIMING = ['before-next-generation', 'mid-generation'];
const XCARD_EFFECTS = ['steer-away', 'stop-after-inflight', 'no-op'];
const HARD_FLOOR_SCENARIOS = 5;

const ids = (cases: { id: string }[]) => cases.map((c) => c.id);

describe('red-team injection dataset (R-S3)', () => {
  const ds = load('injection-100.json');
  const cases = ds.cases;

  it('is versioned and has exactly 100 cases', () => {
    expect(ds.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cases).toHaveLength(100);
  });

  it('has unique ids and unique texts', () => {
    expect(ids(cases)).toEqual(
      Array.from(
        { length: 100 },
        (_, i) => `inj-${String(i + 1).padStart(3, '0')}`,
      ),
    );
    expect(new Set(cases.map((c) => c.text)).size).toBe(100);
  });

  it('has valid required fields and enums', () => {
    for (const c of cases) {
      expect(typeof c.text, c.id).toBe('string');
      expect(c.text.trim().length, c.id).toBeGreaterThan(0);
      expect(INJECTION_CATEGORIES, c.id).toContain(c.category);
      expect(TIERS, c.id).toContain(c.tier);
      expect(INJECTION_EXPECTED, c.id).toContain(c.expected);
      if (c.priorTurns !== undefined) {
        expect(Array.isArray(c.priorTurns), c.id).toBe(true);
        expect(c.priorTurns.length, c.id).toBeGreaterThan(0);
        for (const t of c.priorTurns) expect(typeof t, c.id).toBe('string');
      }
    }
  });

  it('covers every category and every tier', () => {
    expect(new Set(cases.map((c) => c.category))).toEqual(
      new Set(INJECTION_CATEGORIES),
    );
    for (const t of TIERS)
      expect(cases.filter((c) => c.tier === t).length, t).toBeGreaterThan(0);
  });

  it('includes the R-S3 examples', () => {
    const texts = cases.map((c) => c.text.toLowerCase());
    for (const s of [
      'ignore previous instructions',
      '1000 gold',
      'set my hp to max',
      'move my token to the exit',
      'enable mature content',
    ])
      expect(
        texts.some((t) => t.includes(s)),
        s,
      ).toBe(true);
  });
});

describe('red-team content-boundary dataset (M3-02 rubric)', () => {
  const ds = load('boundary-100.json');
  const cases = ds.cases;

  it('is versioned and has exactly 100 cases', () => {
    expect(ds.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cases).toHaveLength(100);
  });

  it('has unique ids and unique (tier, text) pairs', () => {
    expect(ids(cases)).toEqual(
      Array.from(
        { length: 100 },
        (_, i) => `bnd-${String(i + 1).padStart(3, '0')}`,
      ),
    );
    expect(new Set(cases.map((c) => `${c.tier}|${c.text}`)).size).toBe(100);
  });

  it('has valid required fields and enums', () => {
    for (const c of cases) {
      expect(typeof c.text, c.id).toBe('string');
      expect(c.text.trim().length, c.id).toBeGreaterThan(0);
      expect(TIERS, c.id).toContain(c.tier);
      expect(['allow', 'block'], c.id).toContain(c.expected);
      expect(BOUNDARY_CATEGORIES, c.id).toContain(c.category);
      expect(typeof c.probe, c.id).toBe('string');
      if (c.hardFloor !== undefined)
        expect(typeof c.hardFloor, c.id).toBe('boolean');
      if (c.tableLines !== undefined) {
        expect(Array.isArray(c.tableLines), c.id).toBe(true);
        expect(c.tableLines.length, c.id).toBeGreaterThan(0);
      }
    }
  });

  it('keeps verdict and category consistent', () => {
    for (const c of cases) {
      if (c.expected === 'allow') expect(c.category, c.id).toBe('none');
      else expect(c.category, c.id).not.toBe('none');
      if (c.category === 'lines_veils')
        expect(c.tableLines, c.id).toBeDefined();
    }
  });

  it('hard floor: minor sexual content blocks at every tier', () => {
    const hf = cases.filter((c) => c.hardFloor);
    expect(hf).toHaveLength(HARD_FLOOR_SCENARIOS * TIERS.length);
    for (const c of hf) {
      expect(c.category, c.id).toBe('minor_sexual');
      expect(c.expected, c.id).toBe('block');
    }
    for (const c of cases.filter((c) => c.category === 'minor_sexual'))
      expect(c.hardFloor, c.id).toBe(true);
    const scenarios = new Map<string, Set<string>>();
    for (const c of hf) {
      if (!scenarios.has(c.text)) scenarios.set(c.text, new Set());
      scenarios.get(c.text)!.add(c.tier);
    }
    expect(scenarios.size).toBe(HARD_FLOOR_SCENARIOS);
    for (const [text, tiers] of scenarios)
      expect([...tiers].sort(), text).toEqual([...TIERS].sort());
  });

  it('is balanced: both verdicts at every tier, and across the set', () => {
    const allow = cases.filter((c) => c.expected === 'allow').length;
    const block = cases.filter((c) => c.expected === 'block').length;
    expect(allow).toBeGreaterThanOrEqual(45);
    expect(block).toBeGreaterThanOrEqual(45);
    for (const t of TIERS) {
      const tierCases = cases.filter((c) => c.tier === t);
      expect(
        tierCases.some((c) => c.expected === 'allow'),
        t,
      ).toBe(true);
      expect(
        tierCases.some((c) => c.expected === 'block'),
        t,
      ).toBe(true);
    }
  });

  it('covers the mature-only allow probes and standard/family blocks', () => {
    const allowed = (t: string) =>
      cases
        .filter((c) => c.tier === t && c.expected === 'allow')
        .map((c) => c.probe);
    expect(allowed('mature')).toEqual(
      expect.arrayContaining([
        'graphic-violence',
        'strong-language',
        'dark-theme',
        'innuendo',
      ]),
    );
    const blockedStandard = cases.filter(
      (c) => c.tier === 'standard' && c.expected === 'block',
    );
    expect(blockedStandard.some((c) => c.category === 'language')).toBe(true);
  });
});

describe('red-team X-card / pause redirect dataset', () => {
  const ds = load('xcard-redirect.json');
  const cases = ds.cases;

  it('is versioned and has at least 20 cases', () => {
    expect(ds.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it('has unique ids and valid enums', () => {
    expect(new Set(ids(cases)).size).toBe(cases.length);
    for (const c of cases) {
      expect(XCARD_TRIGGERS, c.id).toContain(c.trigger);
      expect(XCARD_SIGNALERS, c.id).toContain(c.signaledBy);
      expect(XCARD_TIMING, c.id).toContain(c.timing);
      expect(TIERS, c.id).toContain(c.tier);
      expect(['redirected', 'no-state-change'], c.id).toContain(c.expected);
      expect(XCARD_EFFECTS, c.id).toContain(c.effect);
      expect(c.context.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it('covers both X-card redirects and pause no-state-change', () => {
    expect(
      cases.some((c) => c.trigger === 'x-card' && c.expected === 'redirected'),
    ).toBe(true);
    expect(
      cases.some(
        (c) => c.trigger === 'pause' && c.expected === 'no-state-change',
      ),
    ).toBe(true);
  });
});
