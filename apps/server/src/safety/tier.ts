export type ContentTier = 'family' | 'standard' | 'mature';

export interface TierInput {
  /** Live accounts.mature_opt_out for each seated account; a missing account counts as opted out. */
  readonly seatedMatureOptOuts: readonly boolean[];
  readonly moderationVerified: boolean;
  /** Operator probe flag endpoint_allows_mature (ADR-013). */
  readonly endpointAllowsMature: boolean;
  /** Host-chosen lower tier; can lower the table but never override an opt-out. */
  readonly hostCap?: 'family' | 'standard';
}

export type TierReason =
  | 'opt_out'
  | 'unverified'
  | 'endpoint_disallows'
  | 'host_cap'
  | 'mature_eligible';

export function computeContentTier(input: TierInput): ContentTier {
  if (input.hostCap) return input.hostCap;
  return tierEligibleForMature(input) ? 'mature' : 'standard';
}

export function reasonForTier(input: TierInput): TierReason {
  if (input.seatedMatureOptOuts.some(Boolean)) return 'opt_out';
  if (!input.moderationVerified) return 'unverified';
  if (!input.endpointAllowsMature) return 'endpoint_disallows';
  if (input.hostCap) return 'host_cap';
  return 'mature_eligible';
}

function tierEligibleForMature(input: TierInput): boolean {
  return (
    !input.seatedMatureOptOuts.some(Boolean) &&
    input.moderationVerified &&
    input.endpointAllowsMature
  );
}
