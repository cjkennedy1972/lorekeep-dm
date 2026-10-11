export type ContentTier = 'family' | 'standard' | 'mature';
export type HostCap = 'family' | 'standard';

export interface TierInput {
  /** Live accounts.mature_opt_out for each seated account; a missing account counts as opted out. */
  readonly seatedMatureOptOuts: readonly boolean[];
  readonly moderationVerified: boolean;
  /** Operator probe flag endpoint_allows_mature (ADR-013). */
  readonly endpointAllowsMature: boolean;
  /** Host-chosen lower tier; can lower the table but never override an opt-out. */
  readonly hostCap?: HostCap;
}

export type TierReason =
  | 'no_seats'
  | 'opt_out'
  | 'host_cap'
  | 'invalid_host_cap'
  | 'unverified'
  | 'endpoint_disallows'
  | 'mature_eligible';

const isHostCap = (value: unknown): value is HostCap =>
  value === 'family' || value === 'standard';

// ponytail: untyped input fails closed; only a literal false is "seated and not opted out".
const anyOptOut = (input: TierInput) =>
  input.seatedMatureOptOuts.some((value) => value !== false);

const eligibleForMature = (input: TierInput) =>
  input.seatedMatureOptOuts.length > 0 &&
  !anyOptOut(input) &&
  input.moderationVerified === true &&
  input.endpointAllowsMature === true;

/** A hostCap that is set but not a valid enum value fails closed to standard. */
export function computeContentTier(input: TierInput): ContentTier {
  if (input.hostCap !== undefined)
    return isHostCap(input.hostCap) ? input.hostCap : 'standard';
  return eligibleForMature(input) ? 'mature' : 'standard';
}

export function reasonForTier(input: TierInput): TierReason {
  if (input.hostCap !== undefined)
    return isHostCap(input.hostCap) ? 'host_cap' : 'invalid_host_cap';
  if (input.seatedMatureOptOuts.length === 0) return 'no_seats';
  if (anyOptOut(input)) return 'opt_out';
  if (input.moderationVerified !== true) return 'unverified';
  if (input.endpointAllowsMature !== true) return 'endpoint_disallows';
  return 'mature_eligible';
}
