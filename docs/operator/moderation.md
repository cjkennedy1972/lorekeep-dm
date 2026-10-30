# Operator guide: moderation, content tiers, opt-out, retention

For the person running a Lorekeep-DM server. Endpoint setup (`fast`, `frontier`, `moderate` slots, probes) is in the [operator guide](../operator-guide.md). This page covers what the moderation endpoint does, how the content tier is computed, the player opt-out, and how long data is kept.

Governing documents:

- [ADR-026](../adr/026-mature-default-false-addendum.md) (Accepted) makes mature opt-in at the endpoint layer: `endpoint_allows_mature` defaults to `false`, and the operator must grant it explicitly.
- [ADR-016](../adr/016-mature-content-gating.md) (Proposed) defines the table tier predicate, the per-player opt-out, live re-evaluation, and runtime refusal handling. Its endpoint-probe default is superseded by ADR-026 (ADR-016's text is unchanged). The endpoint gate is governed by ADR-026 (Accepted) and [ADR-027](../adr/027-mature-endpoint-attestation.md) (accepted by implementation policy, not formally marked Accepted).
- [ADR-017](../adr/017-log-retention-deletion-jobs.md) (Proposed) governs retention.

Where the code differs from an ADR, this page says so. Facts are from `main` at `6c59f9e`, which includes [#212](https://github.com/cjkennedy1972/lorekeep-dm/pull/212) (the mature grant sets `moderation_verified`) and [#213](https://github.com/cjkennedy1972/lorekeep-dm/pull/213) (log purge honors legal holds).

## Status: mature content requires an operator grant

ADR-016 (Proposed) sets the intended default to mature-eligible unless a player opts out. The code does not deliver that by default. Mature becomes reachable only when the operator grants it, for two independent reasons:

- `sessions.endpoint_allows_mature` defaults to `false` (`apps/server/migrations/0033_endpoint_allows_mature_default_false.sql:1`). Only an operator grant through `PATCH /api/operator/sessions/:id/mature-endpoint` sets it to `true` (`apps/server/src/routes/operator.ts:172`).
- `sessions.moderation_verified` defaults to `false` (`apps/server/migrations/0020_mature_tier.sql:2`). The same grant sets it to match `endpoint_allows_mature` (`operator.ts:220`), so it is `true` only after a verified grant and is cleared on revoke.

The grant fails closed. It requires a passing narration probe and a passing `moderate` probe (`ENDPOINT_PROBE_REQUIRED` otherwise, `apps/server/src/llm/matureEndpoint.ts:132`), and the exact `policyAcknowledgement` string. A passing probe is technical only and does not establish that the endpoint's terms permit mature content.

Treat "mature is default-on" as the intended product decision, not the current behavior. Until an operator grants it, every table computes to `standard` or lower.

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

The stored tier (`sessions.content_tier`) and the `ContentTierChanged` event are produced only at narration (computed at `productionTurnRunner.ts:272`, emitted at `:685`, persisted at `persistence/index.ts:279`). A player's opt-out, a join, a leave, or a seat change does not recompute or broadcast the tier on its own; the change takes effect at the next narration. The input gate (`apps/server/src/safety/inputGate.ts:76`) and the stored-recap safety path (`recapSafety` in `apps/server/src/routes/tables.ts`, around line 90) both call `loadContentTierState(db, sessionId, false)`. The third argument is `endpointAllowsMature`, so `false` forces it to `false` when computing tier; it is not a no-store switch. The helper is read-only and does not persist `sessions.content_tier`. Delivery of mature chunks re-checks opt-outs live (see Opt-out below).

Input and recap screening deliberately use the `standard` moderation rubric, even when a session is otherwise mature-eligible. This preserves standard-tier restrictions for those screening decisions—for example, standard blocks innuendo and graphic violence, while mature permits them. This is a targeted screening policy, not a claim that `standard` is stricter in every moderation category.

## Settings and defaults

| Setting | Where | Default | Who sets it | Effect |
| --- | --- | --- | --- | --- |
| `accounts.mature_opt_out` | `apps/server/migrations/0002_accounts.sql:7` | `false` | Each player, via `PATCH /api/me/content-settings` (`apps/server/src/routes/contentSettings.ts:83`) | `true` blocks `mature` for every table the account is seated at. The host cannot override it. |
| `sessions.host_tier_cap` | `apps/server/migrations/0022_host_tier_cap.sql:2` | `NULL` (no cap) | Host, via `PATCH /api/sessions/:id/content-tier` with `family`, `standard`, `mature`, or `null` (`contentSettings.ts:119`) | Lowers the table tier. Setting `mature` clears the cap; it does not force mature. |
| `sessions.content_tier` | `apps/server/migrations/0020_mature_tier.sql:3` | `standard` | Computed each narration | Last committed tier. |
| `sessions.moderation_verified` | `apps/server/migrations/0020_mature_tier.sql:2` | `false` | Operator grant only, set with `endpoint_allows_mature` (`apps/server/src/routes/operator.ts:220`) | Required for `mature`. Cleared on revoke. |
| `sessions.endpoint_allows_mature` | `apps/server/migrations/0033_endpoint_allows_mature_default_false.sql:1` | `false` | Operator, via `PATCH /api/operator/sessions/:id/mature-endpoint` (`apps/server/src/routes/operator.ts:172`) | Required for `mature`. Needs `enabled: true`, the exact `policyAcknowledgement` string, and passing narration and `moderate` probes. Stores fingerprints of both endpoint configurations; the grant is enforced only while both still match (`apps/server/src/llm/matureEndpoint.ts:102`). The fingerprint includes the slot, base URL, model, API style, key fingerprint, and last-saved time (`matureEndpoint.ts:86`), so re-saving an endpoint invalidates the grant even if nothing changed. |
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

Derived DM memory is an unprovenanced, regenerable cache. Account deletion removes scene summaries and registry entries/facts only from sessions where the account or one of its deleted characters appears (owned, occupied, character-bound, character-referencing, or text-referencing); deleting a reusable character removes derived rows only from sessions referencing it. The scrub may discard unrelated summaries/facts in those affected sessions. Canonical events and snapshots remain governed by existing redaction and retention rules, and regenerated text may reference retained content. A provenance-aware memory model is a follow-up.

Deleting an account sets its status to `deleting`. The account-deletion job (`runAccountDeletions`, `apps/server/src/retention/jobs/accountDeletion.ts:549`) then runs on each sweep. PII is removed, solo sessions are deleted, and shared sessions are redacted rather than purged. The job is not timed. A live `session_lease` on any affected session (taken with a 5-minute TTL in `fenceSession`) or a legal hold makes the attempt fail closed as `HELD`. The read-only pre-drain pass checks the account, exports, owned sessions, and sessions found by account-reference scans; character-referenced sessions are checked for holds only inside the deletion transaction, after live Rooms may already have been drained. The account stays `deleting` and is retried on a later sweep. No code enforces ADR-017's target that PII is hard-deleted within 30 days of the request.

ADR-017 also sets rolling 30-day Postgres backups, so full erasure from backups lags deletion by at most 30 days. This repository does not configure backups; the operator's backup setup must enforce that window.

### Differences from ADR-017

- **PII hard-delete within 30 days:** not enforced. Account deletion is job-driven and can be deferred indefinitely by a live `session_lease` or a hold, as described above.
- **Sweep cadence:** ADR-017 says nightly. The code runs hourly by default.
- **Archived sessions:** ADR-017 deletes them 90 days after archive "unless claimed." No claim handling exists in the retention code or migrations, so every archived session is deleted at 90 days unless a legal hold applies.
- **Exports:** ADR-017 says 7 days, and the code matches that value. The code sets the expiry from completion time (`completed_at + 7 days`); ADR-017 does not state an anchor.
- **Reverted turns:** ADR-017 keeps the hidden transcript from rewind for 30 days. No retention job purges reverted turns in `apps/server/src/retention/jobs/`, so that class is not enforced.
- **LLM request/response logs:** ADR-017 lists them in the 30-day class. They are not covered by a table or purge job in this guide.
- **Legal holds on log tables:** ADR-017 says an operator-set hold suspends deletion for the held item. The log purge honors holds with the key scope listed under Legal hold below, which the ADR-017 owner decision of 2026-10-15 records. Retained rows still expire once their hold is cleared.

### Differences from ADR-016 and ADR-026

- **Endpoint-probe default:** ADR-016 says the probe sets `endpoint_allows_mature` to `true`. ADR-026 supersedes this: the column defaults to `false`, and only an operator grant sets it (`apps/server/src/routes/operator.ts:220`). The grant requires a passing probe (`ENDPOINT_PROBE_REQUIRED`) but the probe does not write the flag itself.
- **M3-19 probe:** the endpoint probe (`apps/server/src/llm/probe.ts`, `qualification.ts`) writes no session columns. It does not set `moderation_verified` or `endpoint_allows_mature`.
- **`moderation_verified`:** ADR-016 requires it for `mature` (ADR-013). On `main` only the operator mature grant writes it, together with `endpoint_allows_mature`, after both probes pass (see Status above).
- **Live re-evaluation:** ADR-016 requires recomputing the predicate at round open and on join, leave, seat change, and opt-out toggles, and broadcasting `ContentTierChanged` live. On `main`, only the narration path recomputes and emits it (`productionTurnRunner.ts:272`, `:685`). Opt-out delivery is re-checked live (`Room.ts:1453`), which covers in-flight chunks only.
- **Runtime refusal:** ADR-016 says a refusal sets the endpoint flag to `false` and shows a neutral notice. On `main`, a refused attempt re-runs that turn at `standard` (`productionTurnRunner.ts:662-667`). Nothing clears `endpoint_allows_mature`; the only writer is the operator route. A refused endpoint stays eligible for `mature` until an operator revokes the grant.

### Legal hold

A legal hold is a row in `legal_holds` with kind `account`, `export`, or `session`. Holds are honored by:

- account deletion, export purge, and archived-session purge (`apps/server/src/retention/types.ts:16`, `skipIfHeld`), which skip the held item and write a `skipped_legal_hold` audit row;
- message-report purge, which honors a per-report `legal_hold` flag and a session-level hold (`apps/server/src/retention/jobs/reports.ts:16`);
- gameplay event purge, which skips events of a session with a session-level hold (`apps/server/migrations/0006_retention.sql`, `purge_expired_events`);
- the 30-day log purge (`purgeLogs`, `apps/server/src/retention/jobs/logs.ts`), which keeps an expired row if any of its hold keys is held. The keys are:
  - `moderation_log`: a `session` hold on `session_id`, or an `account` hold on `account_id`;
  - `operator_endpoint_audit`: an `account` hold on `actor_id`;
  - `x_card_log`: a `session` hold on `session_id` only (no account key).

  A row with no matching hold, or with only NULL keys, is purged at `expires_at`. Each held key is audited once as `skipped_legal_hold`.

There is no admin path to set or clear a hold. Holds are managed by direct database action until a follow-up card adds one (ADR-017).

## Checks

- Defaults above were read from the migrations and config named in each row.
- Route paths and the `policyAcknowledgement` string were read from `contentSettings.ts` and `operator.ts`.
- The moderation endpoint slot was confirmed in `inputGate.ts`.
- Legal-hold coverage was checked against `purgeLogs` (hold keys per table, including the NULL-key rule) and each `skipIfHeld` call site.
- The mature grant, probe requirements, `moderation_verified` write, and fingerprint enforcement were checked in `operator.ts`, `matureEndpoint.ts`, `tier.ts`, `tierLoader.ts`, and `app.ts`.
- Account-deletion deferral (`HELD`, `session_lease`), export expiry (`WEEK`), archived-session cutoff, and the absence of claim handling were checked in `accountDeletion.ts`, `exports.ts`, `export.ts`, `sessions.ts`, and the retention and route code.
- Refusal fallback, the operator-only writer of `endpoint_allows_mature`, and the absence of a `moderation_verified` writer were checked in `productionTurnRunner.ts`, `operator.ts`, and `tierLoader.ts`.
- PRs #212 and #213 are merged; their diffs were read and the affected sections updated.
