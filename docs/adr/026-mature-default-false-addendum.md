# ADR-026: Mature content is opt-in at both layers (addendum to ADR-016)

Status: Accepted · Date: 2026-10-15 · Owner: Atlas · Amends ADR-016 (ADR-016 text is unchanged; this note supersedes its default for the endpoint flag)

## Context

Migration 0032 added `sessions.endpoint_allows_mature`. Migration 0033 (PR #207) sets its default to `false` and resets existing rows. Its down migration originally restored the default to `true`, which would silently re-open mature on rollback.

## Decision

- Column `sessions.endpoint_allows_mature` defaults to `false`; existing rows reset to `false`.
- Mature is opt-in at both layers: the column default, and the runner flag, which the operator probe must set to `true` explicitly. The probe wiring is not yet in place, so mature stays unreachable until it is.
- When the flag is true, the ADR-016 per-player opt-out still applies live.
- Migration rollback keeps the default `false`. Reverting to `true` is unsupported.
