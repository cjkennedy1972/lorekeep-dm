# M3-34 scoped moderation-bypass review

**Review date:** 2026-10-16  
**Target:** `origin/main` at `7df49ea7756e32557991e54ac32b4aba5b3ec14d`  
**Scope:** display names and character text, session free text, content-tier opt-out, X-card/pause, and the explicitly listed moderation bypass surfaces. This is a bounded source/probe review, not a general penetration test.

## Executive result

**The report documents the required findings and a reproducible High finding with a linked remediation task; M3-34 is not ready to close.** The R7 remediation task `f344614c-52d6-42cd-9293-b17d90c13844` is linked as a child of M3-34. PR #227 is open/draft at `4a1baa67799adf717d4592e18a2ba9511c085ee6`; hosted CI run [39028767971](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39028767971) succeeded, and Sentinel/Bastion gave exact-head GO. PR #225 is open/draft at `ee7494a326ea2d776537628d7b80d47884247a5f`; hosted CI run [39033409000](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39033409000) succeeded, with Sentinel/Bastion exact-head GO for the declared narrow R1 scope. Neither remediation PR is merged. PR #228's report head is `2dc3348bf8302fdf281b7200636143f785aa89c8`; hosted CI run [39035860525](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39035860525) is in progress. Sentinel and Bastion returned NO-GO on the prior report head `5a6d86c49be30a758d8493f7e6d5859929830d88`; their latest reports did not review this new head. Fresh exact-head reviews are pending. R2–R5 are reproduced deterministic hard-floor misses, but downstream-judge acceptance was not established. The report summarizes the scoped delegated review result delivered under task `m3_34_astra_review`; the author did not independently invoke Astra. The M3-34 Workboard history records owner authorization for the scoped Astra review. The report therefore attributes the result as delegated/relayed rather than claiming a first-hand Astra invocation. The broader M3 milestone is not complete.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R7 | High | Custom character condition text is accepted and rendered without either moderation layer seeing it on the stated target. | Remediation is in draft [PR #227](https://github.com/cjkennedy1972/lorekeep-dm/pull/227), current head `4a1baa67799adf717d4592e18a2ba9511c085ee6`; hosted CI [39028767971](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39028767971) passed and Sentinel/Bastion gave exact-head GO. Tracked by Workboard card `f344614c-52d6-42cd-9293-b17d90c13844`. |
| R1 | Medium, deterministic-layer gap | `Mira 12 is sexual/naked.` missed the hard floor. | Fix in draft [PR #225](https://github.com/cjkennedy1972/lorekeep-dm/pull/225), current head `ee7494a326ea2d776537628d7b80d47884247a5f`; hosted [CI run 39033409000](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39033409000) passed. Sentinel GO and Bastion GO-with-advisories are scoped to this narrow fix. A Bastion review of predecessor PR #225 head `154adaa5d5e2c71aa4663234e8233dca7453bd0d` flagged possible overblocking for a numbered object (`Room 12 is sexy`); the later exact-head GO at `ee7494a` did not explicitly re-test that case. The streaming/chunk-boundary path remains unverified. At current PR #225 head, `Mira 12 is grown and naked.` is blocked; the version is `2026-10-17.26`. The originally reviewed target behavior remains documented above. No judge-path end-to-end verification is claimed. |
| R2–R5 | Medium, deterministic-layer gaps | Symbol substitution, doubled letters, separated age phrase, and missing `unclothe` term miss the hard floor. | No downstream-judge bypass proven. These remain untracked Medium defense-in-depth gaps; the report does not classify them as High or claim the hard floor catches them. |
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

Pinned target sources: [`hardFloor.ts`](https://github.com/cjkennedy1972/lorekeep-dm/blob/7df49ea7756e32557991e54ac32b4aba5b3ec14d/apps/server/src/safety/hardFloor.ts) and [`hard-floor.md`](https://github.com/cjkennedy1972/lorekeep-dm/blob/7df49ea7756e32557991e54ac32b4aba5b3ec14d/docs/security/hard-floor.md).

The route sends hard-floor misses onward to moderation (`apps/server/src/safety/inputGate.ts:177`; `apps/server/src/safety/moderator.ts:240`). Rubrics prohibit minor sexualization. In-memory stubs verified allow/block/fail-closed judge control flow, **not actual model performance**. No live judge call or recorded dataset replay was performed. Therefore R2–R5 demonstrate loss of deterministic defense, not that the judge allows the content.

R1's current proposed fix is PR #225 at `ee7494a326ea2d776537628d7b80d47884247a5f`. It adds an optional copula in `SEXUAL_AFTER`, bumps `HARD_FLOOR_VERSION` to `2026-10-17.26`, updates the Round9 pin and ADR-023, and adds block/allow regression cases, including two additional benign controls on the current head. Sentinel and Bastion GO are limited to R1; Bastion's GO carries the non-blocking advisories about possible overblocking for numbered inanimate entities and the unverified streaming/chunk-boundary path. These are recorded on M3-06b Workboard card `ebcf1212-e2de-48f1-97ff-dc420844f4d3`; judge-path end-to-end behavior remains unverified.

## Medium finding R8: nested checkpoint data in client state

`Room.clientState()` strips top-level `lastNarration`, `lastPlayerText`, `world`, and recap fields (`apps/server/src/room/Room.ts:215–238`), while `saveCheckpoint()` clones full game state (`Room.ts:413–423`). `subscribe()` sends `clientState()` (`Room.ts:195–200`) without the mature-recipient gate. Extracting the exact target methods and supplying fake queue/commit plumbing showed nested checkpoint copies of `lastNarration`, `lastPlayerText`, and `world` remain in the serialized result.

A source search found only the method and test callers; no production route caller of `saveCheckpoint()` was found. This is a reproduced serialization defect for checkpoint-bearing state, **not a proven currently user-triggerable leak**. Use an explicit client-state projection covering nested checkpoints before adding a production caller.

## Other scoped checks and advisories

- Signup/update display names and room/table names are gated: `apps/server/src/routes/auth.ts:263,504`, `sessions.ts:112`, `tables.ts:180`.
- Player actions and clarifications are gated: `apps/server/src/gateway/ws.ts:476,539`; unsupported websocket actions are rejected at `gateway/ws.ts:605`. No separate generic chat handler was found.
- Content settings are authenticated/account-scoped (`contentSettings.ts:83–110)); boundaries are quoted as judge data (`moderator.ts:145–164`).
- Host tier authorization, live-Room cap serialization, lease-path checks, recovered Room sequence, mature delivery recipient checks, and X-card seat/anonymized broadcast paths were inspected; no additional bypass was reproduced. X-card abort is host-opt-in, not an unconditional abort guarantee (`Room.ts:698–716`).
- Per-IP limiter keys permit address rotation in IPv6 (`inputGate.ts:82–94`, `accounts/throttle.ts:18`); account budgets remain. XFF behavior depends on deployment proxy trust; default is `trustProxy=false` (`app.ts:89–99`).
- The eval live path does not resolve/pin operator-provided endpoint hostnames before fetch (`packages/evals/src/live.ts:113–168`); redirects are rejected. No player-controlled runtime path was demonstrated.
- [`docs/security/hard-floor.md`](https://github.com/cjkennedy1972/lorekeep-dm/blob/7df49ea7756e32557991e54ac32b4aba5b3ec14d/docs/security/hard-floor.md) has a stale gate filename, input-scope description, and 20,000-character cap; the pinned implementation uses a 30,000-character cap and a turn-scoped scanner ([`hardFloor.ts`](https://github.com/cjkennedy1972/lorekeep-dm/blob/7df49ea7756e32557991e54ac32b4aba5b3ec14d/apps/server/src/safety/hardFloor.ts#L31)).

## Current remediation status (checked 2026-10-17)

The original findings above remain pinned to target `7df49ea7756e32557991e54ac32b4aba5b3ec14d`; current remediation status is separate from that target snapshot. PR #227 head `4a1baa67799adf717d4592e18a2ba9511c085ee6` adds condition catalog membership validation, gates free-text condition sources before writes, and bounds source/list sizes. Hosted CI run [39028767971](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39028767971) succeeded; Sentinel and Bastion gave exact-head GO. The R7 task is linked as a child of M3-34 in Workboard. PR #225 head `ee7494a326ea2d776537628d7b80d47884247a5f` addresses the narrow R1 scope; hosted CI run [39033409000](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39033409000) succeeded and Sentinel/Bastion gave exact-head GO for that declared scope. Both PRs remain open/draft/unmerged.

The M3-34 card's explicit acceptance bullets require a severity-ranked findings list, a reproduction for each High, and a task or accepted-risk note per High. R7 is reproduced in this report and linked to child task `f344614c-52d6-42cd-9293-b17d90c13844`. R2–R6, R8, A1, and A2 have no separate task or accepted-risk entry here; no owner risk acceptance is implied, and those entries are not required by the card's literal per-High criterion. The card also references a once-per-milestone scoped Astra review; the authorization is recorded in Workboard and a delegated result was delivered as `m3_34_astra_review`, but this artifact does not provide a standalone provider/run transcript. The report distinguishes that limitation rather than claiming a first-hand Astra run.

Sentinel and Bastion returned read-only NO-GO reviews on the prior report head `5a6d86c49be30a758d8493f7e6d5859929830d88`. The reviewers could not access GitHub/Workboard to verify the referenced CI runs and card link; Bastion also requested SHA-pinned source links and precise attribution for the earlier numeric-object advisory. Atlas verified the R7 child link and the #227/#225 live heads, CI runs, and exact-head review comments; those checks do not constitute approval of PR #228. This revision pins the hard-floor source references to the stated target SHA and corrects the attribution and report-head status. Current #228 report head is `2dc3348bf8302fdf281b7200636143f785aa89c8`; hosted CI run [39035860525](https://github.com/cjkennedy1972/lorekeep-dm/actions/runs/39035860525) is in progress. Fresh exact-head review is required after this revision, followed by green CI before M3-34 can be considered for completion. The card remains blocked while those gates are pending.

## Method and limitations

The R7 and R8 findings and R1–R5 outcomes summarize an owner-relayed, scoped Astra review against the stated target SHA. The report author did not run Astra independently; targeted source tracing and local probes are supplementary checks, not a second Astra review. No live model call, HTTP/database integration test, browser session, concurrency test, deployed proxy/DNS test, or recorded M3-28 dataset replay was performed. The report makes no claim of complete penetration testing or live-model bypass resistance. All findings should be rechecked against current heads before closure.
