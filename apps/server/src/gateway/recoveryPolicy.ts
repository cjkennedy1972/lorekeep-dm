/** ADR-037 solo-seat recovery is opt-in until the decision is confirmed. */
export const SOLO_OWNER_RESUME_RECOVERY_ENABLED =
  process.env.SOLO_OWNER_RESUME_RECOVERY_ENABLED === 'true';
