# M3-34 scoped moderation-bypass review

**Review date:** 2026-10-16  
**Target:** `origin/main` at `7df49ea7756e32557991e54ac32b4aba5b3ec14d`  
**Scope:** display names and character text, session free text, content-tier opt-out, X-card/pause, and the explicitly listed moderation bypass surfaces. This is a bounded source/probe review, not a general penetration test.

## Executive result

**M3-34 is not ready to close.** One High finding bypasses both the deterministic hard floor and the downstream judge on user-controlled character text that is rendered to players on the stated target. Its remediation is in unmerged draft PR #227. A second deterministic hard-floor miss (R1) has a proposed fix in draft PR #225; hosted CI is green and Sentinel has given a narrow exact-head GO, while fresh Bastion review is pending. Four more hard-floor misses (R2–R5) were reproduced, but this review did **not** establish that the downstream judge accepts them; they are recorded as Medium defense-in-depth gaps, not proven end-to-end bypasses. This document is a bounded static/probe review; Astra was not performed.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R7 | High | Custom character condition text is accepted and rendered without either moderation layer seeing it on the stated target. | Remediation is in unmerged draft [PR #227](https://github.com/cjkennedy1972/lorekeep-dm/pull/227), current head `29024487f512c429a11d38b651a7a2282c9976a9`; CI and fresh reviews are pending. Tracked by Workboard card `f344614c-52d6-42cd-9293-b17d90c13844`. |
| R1 | Medium, deterministic-layer gap | `Mira 12 is sexual/naked.` missed the hard floor. | Fix in draft [PR #225](https://github.com/cjkennedy1972/lorekeep-dm/pull/225), head `2a9730174079ad1990cf354037a4342b60f0386d`; hosted CI is green and Sentinel GO is scoped to this narrow fix. Fresh Bastion review is pending. No judge-path end-to-end verification is claimed. |
| R2–R5 | Medium, deterministic-layer gaps | Symbol substitution, doubled letters, separated age phrase, and missing `unclothe` term miss the hard floor. | No downstream-judge bypass proven and no independent implementation task opened in this review. Track with red-team threshold evidence; do not claim the hard floor catches these forms. |
| R8 | Medium, conditional reachability | Nested checkpoint snapshots can retain moderated/private prose in serialized client state. | No production caller of `saveCheckpoint()` was found; reachability remains unproven. Fix projection before adding a production caller. |
| R6 | Low | Hard-floor security documentation has stale filename, input scope, and size limit. | Documentation correction recommended. |
| A1 | Medium advisory | Per-IP rate-limit budgets can be rotated with IPv6 address changes. | Account-level limits remain; no demonstrated end-to-end bypass. |
| A2 | Low advisory | Eval endpoint hostname resolution is not pinned before fetch. | Operator-supplied eval endpoint only; no player-controlled runtime path shown. |

## High finding R7: unmoderated character condition text

**Impact:** A prohibited condition identifier can be accepted and shown in a character sheet without passing either the hard floor or judge.

### Source path

1. `apps/server/src/routes/tables.ts:162–169` moderates `body.character.name` only.
2. `packages/schema/src/character.ts:4` accepts condition identifiers using `CatalogIdSchema` and arbitrary `source` strings. `packages/schema/src/catalog.ts:3` checks identifier syntax, not catalog membership.
3. `packages/engine/src/character/validate.ts:53–344` validates other catalog-backed fields but does not validate `conditions`.
4. `apps/server/src/routes/tables.ts:210,235,260` accepts the empty validation result, persists the character, and inserts it into game state.
5. `apps/web/src/features/character/Sheet.tsx:44,92` removes the `condition:` prefix and renders the remaining ID as text.

### Reproduction

Using the actual schema, quick-build, and business-validation source modules at the target SHA, a quick-build character with:

```json
{
  "conditionId": "condition:loli",
  "source": "UNMODERATED_SOURCE_MARKER"
}
```

produced:

```json
{"schemaAccepted":true,"violations":[],"display":["loli"]}
```

The same standalone term is blocked by `checkHardFloor("loli")`. In this route, condition text is never sent to the floor or judge, so this does not depend on model behavior.

**Required disposition:** Validate every user-controlled displayed condition field before persistence/rendering (including `source`, not only the ID), and add a malicious-condition rejection plus legitimate-condition control. The remediation is tracked in Workboard card `f344614c-52d6-42cd-9293-b17d90c13844` and draft [PR #227](https://github.com/cjkennedy1972/lorekeep-dm/pull/227). PR #227 remains unmerged; its tests and exact-head reviews are tracked separately. No HTTP/database/browser mutation was performed in this review; route and UI reachability are established by source tracing.

## Hard-floor findings R1–R5

These are Medium findings because no downstream-judge bypass was proven; this classification reflects defense-in-depth gaps, not demonstrated end-to-end acceptance. The owner may apply a different explicit project severity policy, but it must be stated as such.

Each input was checked with `checkHardFloor(text)`, a turn-scoped scanner using one whole-text push followed by `finish()`, and one-character-at-a-time pushes followed by `finish()`. The following forms missed the deterministic floor:

| ID | Example | Target behavior |
|---|---|---|
| R1 | `Mira 12 is sexual.`, `Mira 12 is naked.` | Block |
| R2 | `l*o*l*i` | Block |
| R3 | `looli`, `chiild sexual`, `child seexual` | Block |
| R4 | `u-n-d-e-r 18 sexual` | Block |
| R5 | `child unclothe her` | Block |

Controls `Mira is 12 and naked.`, `Mira (12) is naked.`, `loli`, `under 18 sexual`, and `child undress her` did block.

Source references include `apps/server/src/safety/hardFloor.ts:245,465,558,564,680,701,710,727,829,865` and `docs/security/hard-floor.md:33`.

The route sends hard-floor misses onward to moderation (`apps/server/src/safety/inputGate.ts:177`; `apps/server/src/safety/moderator.ts:240`). Rubrics prohibit minor sexualization. In-memory stubs verified allow/block/fail-closed judge control flow, **not actual model performance**. No live judge call or recorded dataset replay was performed. Therefore R2–R5 demonstrate loss of deterministic defense, not that the judge allows the content.

R1's current proposed fix is PR #225. It adds an optional copula in `SEXUAL_AFTER`, bumps `HARD_FLOOR_VERSION` to `2026-10-16.12`, updates the Round9 pin and ADR-023, and adds block/allow regression cases, including two additional benign controls on the current head. Sentinel GO is limited to R1; fresh Bastion review remains pending. The original Bastion review raised advisories about possible overblocking for numbered inanimate entities and unreviewed streaming-chunk interaction. These are tracked for current-head disposition; judge-path end-to-end behavior remains unverified.

## Medium finding R8: nested checkpoint data in client state

`Room.clientState()` strips top-level `lastNarration`, `lastPlayerText`, `world`, and recap fields (`apps/server/src/room/Room.ts:215–238`), while `saveCheckpoint()` clones full game state (`Room.ts:413–423`). `subscribe()` sends `clientState()` (`Room.ts:195–200`) without the mature-recipient gate. Extracting the exact target methods and supplying fake queue/commit plumbing showed nested checkpoint copies of `lastNarration`, `lastPlayerText`, and `world` remain in the serialized result.

A source search found only the method and test callers; no production route caller of `saveCheckpoint()` was found. This is a reproduced serialization defect for checkpoint-bearing state, **not a proven currently user-triggerable leak**. Use an explicit client-state projection covering nested checkpoints before adding a production caller.

## Other scoped checks and advisories

- Signup/update display names and room/table names are gated: `apps/server/src/routes/auth.ts:263,504`, `sessions.ts:112`, `tables.ts:180`.
- Player actions and clarifications are gated: `apps/server/src/routes/ws.ts:476,539`; unsupported websocket actions are rejected at `ws.ts:605`. No separate generic chat handler was found.
- Content settings are authenticated/account-scoped (`contentSettings.ts:83–110)); boundaries are quoted as judge data (`moderator.ts:145–164`).
- Host tier authorization, live-Room cap serialization, lease-path checks, recovered Room sequence, mature delivery recipient checks, and X-card seat/anonymized broadcast paths were inspected; no additional bypass was reproduced. X-card abort is host-opt-in, not an unconditional abort guarantee (`Room.ts:698–716`).
- Per-IP limiter keys permit address rotation in IPv6 (`inputGate.ts:82–94`, `accounts/throttle.ts:18`); account budgets remain. XFF behavior depends on deployment proxy trust; default is `trustProxy=false` (`app.ts:89–99`).
- The eval live path does not resolve/pin operator-provided endpoint hostnames before fetch (`packages/evals/src/live.ts:113–168`); redirects are rejected. No player-controlled runtime path was demonstrated.
- `docs/security/hard-floor.md:3,5,45` has stale gate filename, input-scope description, and 20,000-character cap; implementation uses a 30,000-character cap and a turn-scoped scanner (`hardFloor.ts:31`).

## Method and limitations

This document is a static/source-tracing review with targeted local probes against source at the stated target SHA; Astra was not performed. No live model call, HTTP/database integration test, browser session, concurrency test, deployed proxy/DNS test, or recorded M3-28 dataset replay was performed. The report makes no claim of complete penetration testing or live-model bypass resistance. All findings should be rechecked against current heads before closure.
