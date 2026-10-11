import { describe, expect, expectTypeOf, it } from 'vitest';
import { computeContentTier, reasonForTier, type TierInput } from './tier.js';

const eligible: TierInput = {
  seatedMatureOptOuts: [false, false],
  moderationVerified: true,
  endpointAllowsMature: true,
};

function* allCombinations(): Generator<TierInput> {
  const patterns: boolean[][] = [];
  for (let n = 0; n <= 3; n++)
    for (let bits = 0; bits < 1 << n; bits++)
      patterns.push(
        Array.from({ length: n }, (_, i) => Boolean(bits & (1 << i))),
      );
  for (const seatedMatureOptOuts of patterns)
    for (const moderationVerified of [false, true])
      for (const endpointAllowsMature of [false, true])
        for (const hostCap of [undefined, 'family', 'standard'] as const)
          yield {
            seatedMatureOptOuts,
            moderationVerified,
            endpointAllowsMature,
            hostCap,
          };
}

describe('computeContentTier', () => {
  it('is mature only when every condition holds', () => {
    expect(computeContentTier(eligible)).toBe('mature');
    expect(
      computeContentTier({ ...eligible, seatedMatureOptOuts: [false] }),
    ).toBe('mature');
  });

  it.each([
    ['a seated player opted out', { seatedMatureOptOuts: [false, true] }],
    ['moderation is unverified', { moderationVerified: false }],
    ['the endpoint disallows mature', { endpointAllowsMature: false }],
  ])('is standard when %s', (_, override) => {
    expect(computeContentTier({ ...eligible, ...override })).toBe('standard');
  });

  it('lets the host lower the tier to family or standard', () => {
    expect(computeContentTier({ ...eligible, hostCap: 'family' })).toBe(
      'family',
    );
    expect(computeContentTier({ ...eligible, hostCap: 'standard' })).toBe(
      'standard',
    );
  });

  it('lets the host lower to family even when other conditions fail', () => {
    expect(
      computeContentTier({
        seatedMatureOptOuts: [true],
        moderationVerified: false,
        endpointAllowsMature: false,
        hostCap: 'family',
      }),
    ).toBe('family');
  });

  it('counts an opt-out wherever it sits in the seat list', () => {
    expect(
      computeContentTier({
        ...eligible,
        seatedMatureOptOuts: [false, false, false],
      }),
    ).toBe('mature');
    expect(
      computeContentTier({
        ...eligible,
        seatedMatureOptOuts: [false, true, false],
      }),
    ).toBe('standard');
  });
});

describe('reasonForTier', () => {
  it.each([
    ['opt_out', { seatedMatureOptOuts: [true] }],
    ['unverified', { moderationVerified: false }],
    ['endpoint_disallows', { endpointAllowsMature: false }],
    ['host_cap', { hostCap: 'family' as const }],
    ['mature_eligible', {}],
  ])('reports %s', (reason, override) => {
    expect(reasonForTier({ ...eligible, ...override })).toBe(reason);
  });
});

describe('tier predicate inputs', () => {
  it('accepts only booleans, arrays of booleans, and the host-cap enum', () => {
    for (const input of allCombinations()) {
      expect(Object.keys(input).sort()).toEqual([
        'endpointAllowsMature',
        'hostCap',
        'moderationVerified',
        'seatedMatureOptOuts',
      ]);
      expect(
        input.seatedMatureOptOuts.every((v) => typeof v === 'boolean'),
      ).toBe(true);
      expect(typeof input.moderationVerified).toBe('boolean');
      expect(typeof input.endpointAllowsMature).toBe('boolean');
      expect([undefined, 'family', 'standard']).toContain(input.hostCap);
    }
  });
  it('ignores untyped values that would otherwise read as truthy', () => {
    const base = { ...eligible, hostCap: undefined };
    expect(
      computeContentTier({
        ...base,
        moderationVerified: 'yes' as unknown as boolean,
      }),
    ).toBe('standard');
    expect(
      computeContentTier({
        ...base,
        endpointAllowsMature: 1 as unknown as boolean,
      }),
    ).toBe('standard');
    expect(
      computeContentTier({
        ...base,
        seatedMatureOptOuts: [0 as unknown as boolean],
      }),
    ).toBe('standard');
    expect(
      computeContentTier({
        ...base,
        seatedMatureOptOuts: [null as unknown as boolean],
      }),
    ).toBe('standard');
  });

  it.each([
    ['the string mature', 'mature'],
    ['a null', null],
    ['a number', 1],
    ['an object', { tier: 'mature' }],
    ['an unknown string', 'family-ish'],
    ['an empty string', ''],
  ])(
    'fails closed to standard for an off-enum host cap of %s',
    (_, hostCap) => {
      for (const input of allCombinations()) {
        const tier = computeContentTier({
          ...input,
          hostCap: hostCap as unknown as TierInput['hostCap'],
        });
        expect(tier).toBe('standard');
        expect(tier).not.toBe('mature');
      }
    },
  );

  it('reports an off-enum host cap as invalid, not as a host cap or unverified', () => {
    expect(
      reasonForTier({ ...eligible, hostCap: 'mature' as unknown as 'family' }),
    ).toBe('invalid_host_cap');
  });

  it('reports host_cap, not unverified, when a valid cap is set', () => {
    expect(
      reasonForTier({
        ...eligible,
        moderationVerified: false,
        hostCap: 'standard',
      }),
    ).toBe('host_cap');
  });

  it('is standard with zero seated accounts, even when everything else passes', () => {
    expect(computeContentTier({ ...eligible, seatedMatureOptOuts: [] })).toBe(
      'standard',
    );
    expect(reasonForTier({ ...eligible, seatedMatureOptOuts: [] })).toBe(
      'no_seats',
    );
  });

  it('types every input except the host cap as boolean', () => {
    expectTypeOf<TierInput['seatedMatureOptOuts']>().toEqualTypeOf<
      readonly boolean[]
    >();
    expectTypeOf<TierInput['moderationVerified']>().toEqualTypeOf<boolean>();
    expectTypeOf<TierInput['endpointAllowsMature']>().toEqualTypeOf<boolean>();
    expectTypeOf<TierInput['hostCap']>().toEqualTypeOf<
      'family' | 'standard' | undefined
    >();
  });
});

describe('tier predicate properties', () => {
  const cases = [...allCombinations()];

  it('covers at least 64 input combinations', () => {
    expect(cases.length).toBeGreaterThanOrEqual(64);
  });

  it.each(cases.map((c, i) => [i, c] as const))(
    'holds the safety invariants for case %i',
    (_, input) => {
      const tier = computeContentTier(input);
      const anyOptOut = input.seatedMatureOptOuts.some(Boolean);

      if (anyOptOut) expect(tier).not.toBe('mature');
      if (!input.moderationVerified) expect(tier).not.toBe('mature');
      if (!input.endpointAllowsMature) expect(tier).not.toBe('mature');
      if (input.hostCap === 'family') expect(tier).toBe('family');
      if (input.hostCap === 'standard') expect(tier).not.toBe('mature');
    },
  );
});
