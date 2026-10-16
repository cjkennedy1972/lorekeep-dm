# Operator guide: moderation, content tiers, opt-out, retention

For the person running a Lorekeep-DM server. Endpoint setup (`fast`, `frontier`, `moderate` slots, probes) is in the [operator guide](../operator-guide.md). This page covers what the moderation endpoint does, how the content tier is computed, the player opt-out, and how long data is kept.

Source of truth: [ADR-016](../adr/016-mature-content-gating.md) (tiers, opt-out), [ADR-017](../adr/017-log-retention-deletion-jobs.md) (retention), [ADR-026](../adr/026-mature-default-false-addendum.md) and [ADR-027](../adr/027-mature-endpoint-attestation.md) (mature endpoint gate). Where the code differs from an ADR, this page says so.

## Status: mature content is not reachable on a fresh install

ADR-016 sets the product default to mature-eligible unless a player opts out. The code does not yet deliver that, for two independent reasons:

- `sessions.endpoint_allows_mature` defaults to `false` (`apps/server/migrations/0033_endpoint_allows_mature_default_false.sql:1`). Only an operator grant through `PATCH /api/operator/sessions/:id/mature-endpoint` sets it to `true` (`apps/server/src/routes/operator.ts:172`).
- `sessions.moderation_verified` defaults to `false` (`apps/server/migrations/0020_mature_tier.sql:2`). No production code path sets it to `true`; only tests do. Until a verification path exists, the table tier cannot become `mature`.

Treat "mature is default-on" as the intended product decision, not the current behavior. Until the moderation-verification path lands, every table computes to `standard` or lower.

## Content tiers

Tiers are `family`, `standard`, `mature` (`apps/server/src/safety/tier.ts:1`). Explicit sexual content is out of scope at every tier.

The table tier is computed by `computeContentTier` (`apps/server/src/safety/tier.ts:37`):

1. If the host has set a cap, the result is that cap. An invalid cap value fails closed to `standard`.
2. Otherwise the result is `mature` only if all of these hold (`tier.ts:30`):
   - at least one account has ever been seated in the session;
   - no seated account has `mature_opt_out` set, and every seated account is an active adult;
   - `moderation_verified` is `true`;
   - `endpoint_allows_mature` is `true`.
3. Otherwise the result is `standard`.

Seated accounts are read live from `SeatJoined` events (`apps/server/src/safety/tierLoader.ts`). A deleted or suspended account counts as opted out.

### Reading tier state

There is no dedicated tier endpoint. The table's current tier is visible through two things:

- The host's cap, returned as `tierCap` on room data (`apps/web/src/api.ts:20`). `null` means no cap.
- `ContentTierChanged` events in the event log, emitted when the computed tier changes at a narration (`apps/server/src/room/productionTurnRunner.ts:685`). The web client handles it in `apps/web/src/room/reducer.ts:47`.

The tier is recomputed before each narration. It is not pushed live when a player changes an opt-out. The change takes effect at the next narration.

## Settings and defaults

| Setting | Where | Default | Who sets it | Effect |
| --- | --- | --- | --- | --- |
| `accounts.mature_opt_out` | `apps/server/migrations/0002_accounts.sql:7` | `false` | Each player, via `PATCH /api/me/content-settings` (`apps/server/src/routes/contentSettings.ts:83`) | `true` blocks `mature` for every table the account is seated at. The host cannot override it. |
| `sessions.host_tier_cap` | `apps/server/migrations/0022_host_tier_cap.sql:2` | `NULL` (no cap) | Host, via `PATCH /api/sessions/:id/content-tier` with `family`, `standard`, `mature`, or `null` (`contentSettings.ts:119`) | Lowers the table tier. Setting `mature` clears the cap; it does not force mature. |
| `sessions.content_tier` | `apps/server/migrations/0020_mature_tier.sql:3` | `standard` | Computed each narration | Last committed tier. |
| `sessions.moderation_verified` | `apps/server/migrations/0020_mature_tier.sql:2` | `false` | No production writer (see above) | Required for `mature`. |
| `sessions.endpoint_allows_mature` | `apps/server/migrations/0033_endpoint_allows_mature_default_false.sql:1` | `false` | Operator, via `PATCH /api/operator/sessions/:id/mature-endpoint` (`apps/server/src/routes/operator.ts:172`) | Required for `mature`. Needs `enabled: true` and the exact `policyAcknowledgement` string. Bound to the narration and moderation endpoint configurations; changing either one invalidates the grant. |
| `SOLO_TURN_ENDPOINT_SLOT` | environment | `fast` (`apps/server/src/routes/tables.ts:343`) | Operator | Endpoint slot used for narration, and the one the mature grant attests. |
| Moderation endpoint | operator slot `moderate` | not set | Operator, per the [operator guide](../operator-guide.md) | Judges player input (`apps/server/src/safety/inputGate.ts:234`). |

### Opt-out

A player sets `matureOptOut` through `PATCH /api/me/content-settings` (`apps/server/src/routes/contentSettings.ts:83`), at the join screen or in session settings. The change is live:

- the next narration recomputes the tier (`apps/server/src/room/productionTurnRunner.ts:272`);
- before each mature message is sent, the room re-checks every recipient's eligibility (`apps/server/src/room/Room.ts:1453`, `deliverMature`, backed by `apps/server/src/persistence/index.ts:331`). A seat that opts out mid-turn stops receiving the rest of that turn's mature narration.

The opt-out cannot be reversed by the host, and it does not reset when the host changes.

### Host cap

Lowering the cap is always allowed. Raising it to `mature` returns `409 MATURE_NOT_ALLOWED` unless the computed mature conditions above hold (`contentSettings.ts:119`). Only the session owner can change it.

## Moderation endpoint

The moderation classifier uses the `moderate` endpoint slot (`apps/server/src/safety/inputGate.ts:234`). It returns a plain-text JSON verdict, so it needs reachability and streaming, not structured tool calls (ADR-027). Configure it as described in the [operator guide](../operator-guide.md#2-configure-an-endpoint), then run `POST /api/operator/endpoints/moderate/test`.

Moderation and the hard floor apply at every tier. The hard floor is not configurable.

## Retention

Times below are from the code, not the ADR table where they differ.

| Data | Window | Enforced by |
| --- | --- | --- |
| Moderation log (`moderation_log`) | 30 days from write | `expires_at = written_at + 30 days` (`apps/server/migrations/0023_moderation_log.sql:12`); purged by the sweeper (`apps/server/src/retention/jobs/logs.ts`). |
| X-card log (`x_card_log`) | 30 days from write | `apps/server/migrations/0028_x_card_log.sql:7`; purged by the sweeper. |
| Operator endpoint audit (`operator_endpoint_audit`) | 30 days from write | `apps/server/migrations/0011_operator_endpoints.sql:18`; purged by the sweeper. |
| Safety flag event details (`SafetyFlag` events) | 30 days | `apps/server/src/persistence/events.ts:42`; purged by `purge_expired_events`. |
| Message reports | 90 days while open; 30 days after review or dismissal; 90 days after reopen | `apps/server/migrations/0021_message_reports.sql:12`, `apps/server/src/routes/operator.ts:324`, purged by `apps/server/src/retention/jobs/reports.ts`. Authored message text is replaced with `[removed]` when the author's account is deleted (`apps/server/src/retention/jobs/accountDeletion.ts:11`). |
| Idle sessions | Archived after 14 days idle | `apps/server/src/retention/sweeper.ts:44`. |
| Archived sessions | Deleted after 90 days archived | `apps/server/src/retention/jobs/sessions.ts` (ADR-017). |
| Exports | Per export expiry | `apps/server/src/retention/jobs/exports.ts`. |

The sweeper runs every hour by default (`SWEEP_INTERVAL_MS`, `apps/server/src/config.ts:33`). `0` disables it. A sweep that has not completed within 26 hours is reported as stale by the readiness endpoint (`apps/server/src/retention/sweeper.ts:10`).

Deleting an account runs the account-deletion pipeline. PII is removed, solo sessions are deleted, and shared sessions are redacted rather than purged (ADR-017).

### Legal hold

A legal hold is a row in `legal_holds` with kind `account`, `export`, or `session`. Holds are honored by:

- account deletion, export purge, and archived-session purge (`apps/server/src/retention/types.ts:16`, `skipIfHeld`), which skip the held item and write a `skipped_legal_hold` audit row;
- message-report purge, which honors a per-report `legal_hold` flag and a session-level hold (`apps/server/src/retention/jobs/reports.ts:16`);
- gameplay event purge, which skips events of a session with a session-level hold (`apps/server/migrations/0006_retention.sql`, `purge_expired_events`).

**Holds do not apply to the 30-day log tables.** `purgeLogs` (`apps/server/src/retention/jobs/logs.ts`) deletes `moderation_log`, `x_card_log`, and `operator_endpoint_audit` rows by `expires_at` with no hold check. An abuse-review item in those tables older than 30 days is deleted even if a hold exists for its session. Do not rely on a hold to preserve moderation or endpoint-audit rows; this is a known gap, to be closed before any hold is set on that data.

There is no admin path to set or clear a hold. Holds are managed by direct database action until a follow-up card adds one (ADR-017).

## Checks

- Defaults above were read from the migrations and config named in each row.
- Route paths and the `policyAcknowledgement` string were read from `contentSettings.ts` and `operator.ts`.
- The moderation endpoint slot was confirmed in `inputGate.ts`.
- Legal-hold coverage was checked against `purgeLogs` and each `skipIfHeld` call site.
