# Operator guide: moderation, content tiers, opt-out, retention

For the person running a Lorekeep-DM server. Endpoint setup (`fast`, `frontier`, `moderate` slots, probes) is in the [operator guide](../operator-guide.md). This page covers what the moderation endpoint does, how the content tier is computed, the player opt-out, and how long data is kept.

Governing documents:

- [ADR-026](../adr/026-mature-default-false-addendum.md) (Accepted) makes mature opt-in at the endpoint layer: `endpoint_allows_mature` defaults to `false`, and the operator must grant it explicitly.
- [ADR-016](../adr/016-mature-content-gating.md) (Proposed) defines the table tier predicate, the per-player opt-out, live re-evaluation, and runtime refusal handling. Its endpoint-probe default is superseded by ADR-026 (ADR-016's text is unchanged). The endpoint gate is governed by ADR-026 and [ADR-027](../adr/027-mature-endpoint-attestation.md).
- [ADR-017](../adr/017-log-retention-deletion-jobs.md) (Proposed) governs retention.

Where the code differs from an ADR, this page says so. Facts are from `main` at `64c1418`. Items marked **pending** are in draft PRs that are not merged: [#212](https://github.com/cjkennedy1972/lorekeep-dm/pull/212) (sets `moderation_verified`) and [#213](https://github.com/cjkennedy1972/lorekeep-dm/pull/213) (honors legal holds in log purge).

## Status: mature content is not reachable on a fresh install

ADR-016 (Proposed) sets the intended default to mature-eligible unless a player opts out. The code does not yet deliver that, for two independent reasons:

- `sessions.endpoint_allows_mature` defaults to `false` (`apps/server/migrations/0033_endpoint_allows_mature_default_false.sql:1`). Only an operator grant through `PATCH /api/operator/sessions/:id/mature-endpoint` sets it to `true` (`apps/server/src/routes/operator.ts:172`).
- `sessions.moderation_verified` defaults to `false` (`apps/server/migrations/0020_mature_tier.sql:2`). No production code path sets it to `true`; only tests do. Until a verification path exists, the table tier cannot become `mature`.

Treat "mature is default-on" as the intended product decision, not the current behavior. On `main`, nothing writes `moderation_verified`, so every table computes to `standard` or lower. **Pending:** PR #212 would set it only after a verified mature grant.

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

- The host's cap, returned as `tierCap` on room data (`apps/web/src/api.ts:21`). `null` means no cap.
- `ContentTierChanged` events in the event log, emitted when the computed tier changes at a narration (`apps/server/src/room/productionTurnRunner.ts:685`). The web reducer leaves room state unchanged for it (`apps/web/src/room/reducer.ts:47`); the client surfaces it separately.

The stored tier (`sessions.content_tier`) and the `ContentTierChanged` event are produced only at narration (computed at `productionTurnRunner.ts:272`, emitted at `:685`, persisted at `persistence/index.ts:279`). A player's opt-out, a join, a leave, or a seat change does not recompute or broadcast the tier on its own; the change takes effect at the next narration. The input gate calls `loadContentTierState(db, sessionId, false)` (`apps/server/src/safety/inputGate.ts:76`). The third argument is `endpointAllowsMature`; `false` forces it to `false` when computing eligibility. It is not a no-store option: the call only reads `sessions` and never writes `sessions.content_tier`. Delivery of mature chunks re-checks opt-outs live (see Opt-out below).

## Settings and defaults

| Setting | Where | Default | Who sets it | Effect |
| --- | --- | --- | --- | --- |
| `accounts.mature_opt_out` | `apps/server/migrations/0002_accounts.sql:7` | `false` | Each player, via `PATCH /api/me/content-settings` (`apps/server/src/routes/contentSettings.ts:83`) | `true` blocks `mature` for every table the account is seated at. The host cannot override it. |
| `sessions.host_tier_cap` | `apps/server/migrations/0022_host_tier_cap.sql:2` | `NULL` (no cap) | Host, via `PATCH /api/sessions/:id/content-tier` with `family`, `standard`, `mature`, or `null` (`contentSettings.ts:119`) | Lowers the table tier. Setting `mature` clears the cap; it does not force mature. |
| `sessions.content_tier` | `apps/server/migrations/0020_mature_tier.sql:3` | `standard` | Computed each narration | Last committed tier. |
| `sessions.moderation_verified` | `apps/server/migrations/0020_mature_tier.sql:2` | `false` | No writer on `main`. **Pending:** PR #212 | Required for `mature`. |
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

The windows below are what the code enforces. ADR-017 is the design target; the differences are listed after the table.

| Data | Window | Enforced by |
| --- | --- | --- |
| Moderation log (`moderation_log`) | 30 days from write | `expires_at = written_at + 30 days` (`apps/server/migrations/0023_moderation_log.sql:12`); purged by the sweeper (`apps/server/src/retention/jobs/logs.ts`). |
| X-card log (`x_card_log`) | 30 days from write | `apps/server/migrations/0028_x_card_log.sql:7`; purged by the sweeper. |
| Operator endpoint audit (`operator_endpoint_audit`) | 30 days from write | `apps/server/migrations/0011_operator_endpoints.sql:18`; purged by the sweeper. |
| Safety flag event details (`SafetyFlag` events) | 30 days | `apps/server/src/persistence/events.ts:42`; purged by `purge_expired_events`. |
| Message reports | 90 days while open; 30 days after review or dismissal; 90 days after reopen | `apps/server/migrations/0021_message_reports.sql:12`, `apps/server/src/routes/operator.ts:324`, purged by `apps/server/src/retention/jobs/reports.ts`. Authored message text is replaced with `[removed]` when the author's account is deleted (`apps/server/src/retention/jobs/accountDeletion.ts:11`). |
| Idle sessions | Archived after 14 days idle | `apps/server/src/retention/sweeper.ts:44`. |
| Archived sessions | Deleted 90 days after archive, unless a legal hold applies. There is no claim handling. | `apps/server/src/retention/jobs/sessions.ts` (`purgeArchivedSessions`). |
| Exports | 7 days after completion (`expires_at = completed_at + 604800000 ms`) | `apps/server/src/accounts/export.ts:4`, `:114`; purged by `apps/server/src/retention/jobs/exports.ts`. |

The sweeper runs every hour by default (`SWEEP_INTERVAL_MS`, `apps/server/src/config.ts:33`). `0` disables it. A sweep that has not completed within 26 hours is reported as stale by the readiness endpoint (`apps/server/src/retention/sweeper.ts:10`).

Deleting an account sets its status to `deleting`. The account-deletion job (`runAccountDeletions`, `apps/server/src/retention/jobs/accountDeletion.ts:549`) then runs on each sweep. PII is removed, solo sessions are deleted, and shared sessions are redacted rather than purged. The job is not timed. A live `session_lease` on any affected session (taken with a 5-minute TTL in `fenceSession`) or a legal hold makes the attempt fail closed as `HELD`. The account stays `deleting` and is retried on a later sweep. No code enforces ADR-017's target that PII is hard-deleted within 30 days of the request.

ADR-017 also sets rolling 30-day Postgres backups, so full erasure from backups lags deletion by at most 30 days. This repository does not configure backups; the operator's backup setup must enforce that window.

### Differences from ADR-017

- **PII hard-delete within 30 days:** not enforced. Account deletion is job-driven and can be deferred indefinitely by a live `session_lease` or a hold, as described above.
- **Sweep cadence:** ADR-017 says nightly. The code runs hourly by default.
- **Archived sessions:** ADR-017 deletes them 90 days after archive "unless claimed." No claim handling exists in the retention code or migrations, so every archived session is deleted at 90 days unless a legal hold applies.
- **Exports:** ADR-017 says 7 days, and the code matches that value. The code sets the expiry from completion time (`completed_at + 7 days`); ADR-017 does not state an anchor.
- **Reverted turns:** ADR-017 keeps the hidden transcript from rewind for 30 days. No retention job purges reverted turns in `apps/server/src/retention/jobs/`, so that class is not enforced.
- **LLM request/response logs:** ADR-017 lists them in the 30-day class. They are not covered by a table or purge job in this guide.
- **Legal holds on log tables:** ADR-017 says an operator-set hold suspends deletion for the held item. The 30-day log tables ignore holds on `main` (see Legal hold below). **Pending:** PR #213.

### Differences from ADR-016 and ADR-026

- **Endpoint-probe default:** ADR-016 says the probe sets `endpoint_allows_mature` to `true`. ADR-026 supersedes this: the column defaults to `false`, and only an operator grant sets it (`apps/server/src/routes/operator.ts:219`). The grant requires a passing probe (`ENDPOINT_PROBE_REQUIRED`) but the probe does not write the flag itself.
- **M3-19 probe:** the endpoint probe (`apps/server/src/llm/probe.ts`, `qualification.ts`) writes no session columns. It does not set `moderation_verified` or `endpoint_allows_mature`.
- **`moderation_verified`:** ADR-016 requires it for `mature` (ADR-013). No code on `main` writes it. **Pending:** PR #212.
- **Live re-evaluation:** ADR-016 requires recomputing the predicate at round open and on join, leave, seat change, and opt-out toggles, and broadcasting `ContentTierChanged` live. On `main`, only the narration path recomputes and emits it (`productionTurnRunner.ts:272`, `:685`). Opt-out delivery is re-checked live (`Room.ts:1453`), which covers in-flight chunks only.
- **Runtime refusal:** ADR-016 says a refusal sets the endpoint flag to `false` and shows a neutral notice. On `main`, a refused attempt re-runs that turn at `standard` (`productionTurnRunner.ts:662-667`). Nothing clears `endpoint_allows_mature`; the only writer is the operator route. A refused endpoint stays eligible for `mature` until an operator revokes the grant.

### Legal hold

A legal hold is a row in `legal_holds` with kind `account`, `export`, or `session`. Holds are honored by:

- account deletion, export purge, and archived-session purge (`apps/server/src/retention/types.ts:16`, `skipIfHeld`), which skip the held item and write a `skipped_legal_hold` audit row;
- message-report purge, which honors a per-report `legal_hold` flag and a session-level hold (`apps/server/src/retention/jobs/reports.ts:16`);
- gameplay event purge, which skips events of a session with a session-level hold (`apps/server/migrations/0006_retention.sql`, `purge_expired_events`).

**Holds do not apply to the 30-day log tables on `main`.** **Pending:** PR #213 would make `purgeLogs` honor holds. `purgeLogs` (`apps/server/src/retention/jobs/logs.ts`) deletes `moderation_log`, `x_card_log`, and `operator_endpoint_audit` rows by `expires_at` with no hold check. An abuse-review item in those tables older than 30 days is deleted even if a hold exists for its session. Do not rely on a hold to preserve moderation or endpoint-audit rows; this is a known gap, to be closed before any hold is set on that data.

There is no admin path to set or clear a hold. Holds are managed by direct database action until a follow-up card adds one (ADR-017).

## Checks

- Defaults above were read from the migrations and config named in each row.
- Route paths and the `policyAcknowledgement` string were read from `contentSettings.ts` and `operator.ts`.
- The moderation endpoint slot was confirmed in `inputGate.ts`.
- Legal-hold coverage was checked against `purgeLogs` and each `skipIfHeld` call site.
- Account-deletion deferral (`HELD`, `session_lease`), export expiry (`WEEK`), archived-session cutoff, and the absence of claim handling were checked in `accountDeletion.ts`, `exports.ts`, `export.ts`, `sessions.ts`, and the retention and route code.
- Refusal fallback, the operator-only writer of `endpoint_allows_mature`, and the absence of a `moderation_verified` writer were checked in `productionTurnRunner.ts`, `operator.ts`, and `tierLoader.ts`.
- Pending items were checked against the titles and draft status of PRs #212 and #213 only. Their code was not read.
