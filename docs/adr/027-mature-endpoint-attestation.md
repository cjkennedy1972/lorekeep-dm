# ADR-027: Explicit endpoint attestation for mature content

Status: accepted by implementation policy, 2026-10-15

## Context

ADR-026 made mature content opt-in at both the table and endpoint layers, but the endpoint gate was not wired. The existing generic capability probe tests reachability, streaming, structured calls, and context size. Those technical capabilities do not establish that a provider's acceptable-use policy permits mature content.

## Decision

Mature eligibility is enabled per session only by an authenticated configured operator via `PATCH /api/operator/sessions/:id/mature-endpoint`. The narration endpoint probe must show reachability, streaming, and a supported structured-call mode. The `moderate` classifier endpoint probe must show reachability and streaming; it does not need structured-call support because it returns a plain-text JSON verdict. The narration mode's capability flag encodes its own 95% valid-call threshold; the profile's aggregate call rate is not used because it combines both modes. The operator must explicitly attest that both endpoints' applicable terms/policies permit the product's defined mature tier. The technical probes are not evaluation-suite qualification and do not infer policy permission; policy permission comes only from the operator attestation. The grant is scoped to the session and fingerprints of both endpoint configurations; changing either endpoint or losing/mismatching either probe makes the grant ineffective. Operators can revoke the session grant with `{ "enabled": false }`. The session flag and endpoint fingerprints default to disabled/null.

The host must still raise the table tier, moderation must be verified, all seated accounts must meet existing age/opt-out/live-play gates, and all hard safety rules remain in force. Explicit sexual content remains out of scope. Provider refusal continues to degrade to standard.

## Consequences

- No endpoint or session becomes mature-eligible merely because a generic probe succeeded.
- The operator owns provider-policy review and must repeat the session-specific attestation after endpoint configuration changes.
- The grant is not portable across endpoint changes and does not itself raise any table's content tier.
- Local endpoints require the operator to attest that their configuration is suitable; absence of provider AUP does not waive product safety gates.
