# ADR-042: Gated scene progression with durable commit semantics

Status: Proposed · Date: 2026-11-01 · Owner: Sage · Work item: card `5fd8ad52` · Depends on: ADR-003, ADR-005, ADR-022, ADR-024, ADR-033, ADR-038

Append-only: this ADR gates the existing DM-requested scene close/advance path. It does not change scene authoring, combat resolution, or the turn/narration contracts in the referenced ADRs.

## Context

The server already exposes `close_scene` through `createSceneCloseExecutor` (`apps/server/src/room/sceneCloseTool.ts`), summarizes closed scenes in `apps/server/src/dm/summarize.ts`, and chooses authored successors through `nextSceneAfterClose` (`packages/engine/src/adventure/transition.ts`). `ProductionSoloTurnRunner` currently creates the close executor per turn and applies scene transitions after receiving `SceneClosed` (`apps/server/src/room/productionTurnRunner.ts`). ADR-038 established the rollout precedent: `LOREKEEP_ADR_038_STORY_COMBAT` is false unless its value is exactly `true`.

The current close tool depends on an LLM judgment of player leave intent, but that is not a durable server invariant. A DM result can otherwise request a scene transition during an unresolved turn, while a clarification is pending, during combat, or before the narration for the turn has committed. A process-local “already closed” marker would not protect retries after restart. A successful transition also needs an unambiguous player-visible signal; silently replacing the active scene leaves the party uncertain about what changed.

## Decision

Introduce a server-owned gated progression commit. The DM may propose closing the current scene and, optionally, selecting one of its authored successors. A proposal is intent only: it does not change active scene state, write the canonical `SceneClosed` event, or commit a scene summary. The proposal is accepted only at the authoritative turn-commit seam, after all of these conditions are true for the same session and action:

1. The player turn has been resolved and its `TurnResolved` record is committed.
2. There is no open clarification in the session.
3. No combat is active in authoritative room/engine state.
4. The action's narration has been committed as a player-visible `NarrationCompleted` result (including the normal approved/held-output policy; a missing, rejected, or uncommitted narration is not sufficient).
5. The current scene still matches the proposal's source scene, and the requested successor is either omitted or belongs to that scene's authored `nextSceneIds`.
6. The flag is enabled at commit time.

Check these predicates under the room's serialized authoritative command path, not from model context or a stale runner snapshot. Commit `TurnResolved`, `NarrationCompleted`, `SceneClosed`, the resulting scene/completion state, and the player-visible scene-change update atomically in the existing durable event/state transaction. The committed `SceneClosed` event identifies the source scene, chosen successor or completion, and the originating action/transition key. Summarization is derived from the accepted committed transition; a summary failure must not reverse or partially apply progression. It may be retried independently with the existing idempotent summary write semantics.

No player-intent classifier is a prerequisite. The model decides when to propose based on the adventure and play, but the server exclusively decides whether the transition is eligible and which target is valid. The server must never infer a target from narration or player text. For authored branching scenes, the proposal may select only an exact declared successor; when omitted, preserve the existing deterministic default (the first authored successor). A scene with no successor closes the adventure. Invalid or stale proposals fail closed and leave active scene and event history unchanged.

### Feature flag

Add `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION`, enabled only when equal to the string `"true"`, following ADR-038's flag pattern. Default is OFF in every environment. When OFF, do not expose the DM progression affordance and reject any stale/forged progression proposal at commit; do not fall through to the legacy ungated close path. Existing sessions remain on their current scene. Turning the flag OFF stops new transitions; it does not undo committed transitions or suppress recovery/replay of prior events.

### Durable state and idempotency

The canonical event log and existing room/session state remain authoritative; do not add a process-local progression cache or a second mutable source of current-scene truth. Persist a stable transition key derived from the session and originating action id in the accepted `SceneClosed` record (and its transaction identity). Enforce at-most-once commit under the room serialization/DB transaction: a retry with the same key returns/replays the prior committed outcome without duplicating the summary, transition, player notification, or advancement. A retry with the same key but conflicting source/target is rejected as an idempotency conflict. A different action cannot close a scene that is no longer current.

On process restart, rebuild current scene/completion and idempotent outcomes from the committed event log/snapshot. A turn that committed but whose acknowledgment was lost returns the already-committed outcome; a turn whose transaction did not commit remains eligible for normal turn retry and must not appear progressed. Persisting the transition and the turn/narration decision together prevents a crash from reporting a scene change that cannot be recovered. Any summary/reconciliation worker must use the transition key as its idempotency key.

### Player experience

After a committed transition, send every connected player a clear, ordinary scene-change update naming the destination using its player-safe authored title (or state plainly that the adventure has ended). The update is part of the committed visible result, not inferred from the model's prose. Include a concise indication that the prior scene is over and refresh scene-specific objectives/context. Do not include internal rejection codes, hidden authoring data, or the scene summary as a substitute for this feedback. No scene-change feedback is sent for a rejected proposal.

## Failure behavior

| Condition | Result |
|---|---|
| Flag off, no active adventure/scene, unknown source, or invalid successor | Reject with a closed tool/commit error; no scene or summary mutation. |
| Turn unresolved or narration not durably committed | Defer/reject progression for this action; keep the current scene. Do not synthesize a missing narration or mark the turn complete. |
| Open clarification | Reject progression; preserve the clarification and current scene. A later resolved action may propose again. |
| Active combat | Reject progression; combat remains authoritative. Combat ending alone does not advance the scene; a later eligible turn must propose. |
| Concurrent or stale proposal | Serialize; accept at most one. A proposal whose source is no longer current is a no-op/error, never a second transition. |
| Duplicate retry after commit | Return the original outcome based on transition key; do not duplicate events, summaries, or player updates. |
| Crash before atomic commit | Recover the old scene and permit retry; no partial transition is observable. |
| Crash after commit/before response or push | Recover the new scene and resend/replay the same committed update without a second transition. |
| Summary generation/storage failure after transition | Keep the committed scene change; retry summary separately and idempotently. Record bounded, non-player-text diagnostic telemetry. |

Closed errors shown to the model may distinguish retryable from terminal cases, but player-facing errors remain generic. Never log raw player text or model reasoning as part of progression diagnostics.

## Consequences

- Scene progression has one deep server seam: a small proposal interface and one authoritative commit operation contain eligibility checks, idempotency, durable state update, and visible feedback.
- The existing `close_scene` player-leave judgment is not an authorization condition. Remove it from the enabled progression path; do not retain an alternate route that bypasses the commit gate.
- Scene state and the event log remain replayable without migration to a separate mutable table. If implementation discovers that current persistence cannot atomically commit these records, stop and bring a follow-up design decision rather than weakening the invariant with process memory.
- The strict narration condition means scene movement may wait for a later turn when output is held or not committed. This is preferable to advancing the party without a committed explanation.
- Feature-off sessions cannot progress via the DM tool, which is intentional while the change is being validated.

## Implementation acceptance tests (required; not run for this design-only ADR)

1. Flag parsing: unset, false, and non-`true` values keep the affordance absent and make the server reject progression; only exact `true` enables the proposal path. Verify there is no legacy ungated route.
2. Gate matrix: independently fail each condition—unresolved turn, open clarification, active combat, missing/uncommitted/held narration, wrong source scene, invalid successor, and disabled flag—and prove no `SceneClosed`, summary, scene-state update, or scene-change player message was committed.
3. Positive paths: eligible resolved turn with committed narration closes a terminal scene; valid authored successor advances to that successor; omitted branch uses the documented authored default. Assert state and canonical event agree.
4. Retry and concurrency: deliver the same action/transition twice, including concurrent requests, and prove one transition event, one summary identity, one state change, and one logical visible update. Reusing the key with altered source/target fails closed. A new action against an already-closed source cannot advance twice.
5. Restart recovery: restart after commit but before acknowledgment/push and verify replay restores the destination and replays the original visible outcome without a duplicate transition. Restart before commit and prove the source scene remains current and retry is safe.
6. Atomicity/fault injection: fail each persistence step around turn resolution, narration, transition and scene state; transaction rollback must expose either the fully old state or fully committed new state, never a partial transition. Separately fail summary persistence and prove the scene remains advanced and summary retry is idempotent.
7. Player UX: all relevant seats receive one clear, safe scene-change/ending update only after commit; rejected attempts send none; scene-specific context refreshes. Verify no hidden authoring fields or technical gate errors leak.
8. Integration regression: ordinary exploration, clarification resolution, active combat/combat end, rewind/replay, session restart and existing ADR-038 combat start remain unaffected. Include the current scripted-scene smoke caveat: its database-seeded scene transition does not validate the DM progression path.

## Rollout

1. Implement behind the new default-OFF flag; ship the proposal schema, gate, atomic event/state commit, restart recovery, and player UX together. Keep ADR-038 combat-start behavior and flag independent.
2. Run unit, transaction, integration, restart and visibility checks above with the flag OFF and ON in fixtures/staging. Confirm OFF behavior has no scene progression affordance and that existing session recovery still works.
3. Enable only in development, then a small canary cohort. Observe aggregate accepted/rejected/deferred counts, duplicate-retry counts, recovery mismatches and summary retry backlog; exclude player text, model reasoning, and sensitive scene content from telemetry.
4. Expand only after canary evidence demonstrates durable exactly-once outcomes and clear player feedback. Roll back by setting the flag OFF; already committed state remains authoritative and playable. Do not rewrite or reverse committed transitions as part of flag rollback.

## Alternatives considered

- **Keep player leave-intent judgment as the gate.** Rejected: intent is neither the required turn/combat/narration invariant nor durable across retries, and a model judgment can fail or be induced inconsistently.
- **Advance directly in the DM runner before room commit.** Rejected: it can race authoritative combat/clarification state and separate advancement from durable turn/narration commit.
- **Process-local idempotency cache.** Rejected: it is lost on restart and cannot prevent duplicate durable progression.
- **Advance from narration or player text heuristics.** Rejected: ambiguous, injection-prone, and not authoritative.

## Verification record

Design-only ADR; no code or tests changed/run. Source inspection in the current `origin/main` worktree: `apps/server/src/room/sceneCloseTool.ts` (current leave-intent gate), `apps/server/src/room/productionTurnRunner.ts` (ADR-038 flag, close executor and transition application), `packages/engine/src/adventure/transition.ts` (authored successor selection), and `apps/server/src/room/Room.ts` (turn resolution, clarification and narration commit paths). Repowise was unavailable because its authorization had expired; claims were checked against source. The running scripted smoke for ADR-038 does not exercise the DM scene-progression path.
