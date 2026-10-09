import type { EndpointProfile } from './probe.js';

/** Initial qualification thresholds (spec A10 / m2-overview Q4). Mirrors packages/evals/data/thresholds.json (drift-tested). */
export const THRESHOLDS = {
  rulesCorrect: { min: 0.9 },
  puppetingRate: { max: 0.02, exclusive: true },
  mapContradictionRate: { max: 0.02, exclusive: true },
  toolValidity: { min: 0.95 },
} as const;

/** Subset of the @game/evals EvalRecord that qualification reads. */
export interface EvalRecordLike {
  mode: 'recorded' | 'live';
  endpointProfileId: string;
  suites: Record<
    'rules' | 'puppeting' | 'mapContradiction' | 'toolValidity',
    { score: number; n: number }
  >;
}

const finite = (
  s: { score: number; n: number } | undefined,
): s is { score: number; n: number } =>
  !!s && Number.isFinite(s.score) && s.score >= 0 && s.score <= 1 && s.n > 0;

/** True when a live record's scores meet every threshold; the record's own `passed` flag is never trusted. */
export function meetsThresholds(record: EvalRecordLike): boolean {
  const { rules, puppeting, mapContradiction, toolValidity } =
    record.suites ?? {};
  return (
    finite(rules) &&
    finite(puppeting) &&
    finite(mapContradiction) &&
    finite(toolValidity) &&
    rules.score >= THRESHOLDS.rulesCorrect.min &&
    puppeting.score < THRESHOLDS.puppetingRate.max &&
    mapContradiction.score < THRESHOLDS.mapContradictionRate.max &&
    toolValidity.score >= THRESHOLDS.toolValidity.min
  );
}

/**
 * Qualified only when the endpoint can tool-call (R-L2), and the latest live
 * record stored for exactly this profile id meets thresholds. Recorded-mode
 * records and records for other profiles never qualify. No record → false.
 */
export function isQualified(
  profile: Pick<EndpointProfile, 'id' | 'toolMode'>,
  records: EvalRecordLike[],
): boolean {
  if (profile.toolMode === 'unsupported') return false;
  const latest = records
    .filter((r) => r.mode === 'live' && r.endpointProfileId === profile.id)
    .at(-1);
  return !!latest && meetsThresholds(latest);
}

export const withQualification = (
  profile: EndpointProfile,
  records: EvalRecordLike[],
): EndpointProfile => ({
  ...profile,
  qualified: isQualified(profile, records),
});
