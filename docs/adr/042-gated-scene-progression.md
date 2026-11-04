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

Check these predicates under the room's serialized authoritative command path, not from model context or a stale runner snapshot. Commit `TurnResolved`, `NarrationCompleted`, `SceneClosed`, and the resulting scene/completion state atomically in the existing durable event/state transaction; send any player-visible scene-change update only after commit, with reconnect recovery through StateSync projection. The committed `SceneClosed` event identifies the source scene, chosen successor or completion, and a server-generated opaque `transitionKey`, returned and persisted only as metadata. Retries, duplicate detection, and conflict detection use the private internal request/commit identity; `transitionKey` is never an input to idempotency and does not encode action identity. Summarization is derived from the accepted committed transition; a summary failure must not reverse or partially apply progression. It may be retried independently with summary-write idempotency based on the private internal request/commit identity; `transitionKey` remains metadata only.

The accepted gate-inference residual is recorded in the “Required acceptance/fault cases and blocked status” section of the Bastion design review revision below.

No player-intent classifier is a prerequisite. The model decides when to propose based on the adventure and play, but the server exclusively decides whether the transition is eligible and which target is valid. The server must never infer a target from narration or player text. For authored branching scenes, the proposal may select only an exact declared successor; when omitted, preserve the existing deterministic default (the first authored successor). A scene with no successor closes the adventure. Invalid or stale proposals fail closed and leave active scene and event history unchanged.

### Feature flag

Add `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION`, enabled only when equal to the string `"true"`, following ADR-038's flag pattern. Default is OFF in every environment. When OFF, do not expose the DM progression affordance and reject any stale/forged progression proposal at commit; do not fall through to the legacy ungated close path. Existing sessions remain on their current scene. Turning the flag OFF stops new transitions; it does not undo committed transitions or suppress event-log recovery.

### Durable state and idempotency

The canonical event log and existing room/session state remain authoritative; do not add a process-local progression cache or a second mutable source of current-scene truth. Generate a server-random opaque `transitionKey` for each committed transition and persist it in the accepted `SceneClosed` record; return it only as metadata. It is not derived from session, action, or event-sequence identifiers and exposes neither action identity nor ordering. Enforce at-most-once commit under the room serialization/DB transaction using the private internal request/commit identity: duplicate retries return the prior committed outcome without duplicating the summary, transition, player notification, or advancement. A retry under that identity that conflicts with the recorded source/target is rejected as an idempotency conflict. `transitionKey` is never used as an idempotency input. A different action cannot close a scene that is no longer current.

On process restart, rebuild current scene/completion and idempotent outcomes from the committed event log/snapshot. A turn that committed but whose acknowledgment was lost returns the already-committed outcome; a turn whose transaction did not commit remains eligible for normal turn retry and must not appear progressed. Persisting the transition and the turn/narration decision together prevents a crash from reporting a scene change that cannot be recovered. Any summary/reconciliation worker must use its private internal request/commit identity for idempotency; `transitionKey` is metadata only.

### Player experience

After a committed transition, send every connected player a clear, ordinary scene-change update naming the destination using its player-safe authored title (or state plainly that the adventure has ended). The live StateSync update is expected on commit and is part of the committed visible result, not inferred from the model's prose; reconnecting seats recover current scene state from StateSync. Include a concise indication that the prior scene is over and refresh scene-specific objectives/context. Do not include internal rejection codes, hidden authoring data, or the scene summary as a substitute for this feedback. No scene-change feedback is sent for a rejected proposal.

## Failure behavior

| Condition | Result |
|---|---|
| Flag off, no active adventure/scene, unknown source, or invalid successor | Reject with a closed tool/commit error; no scene or summary mutation. |
| Turn unresolved or narration not durably committed | Defer/reject progression for this action; keep the current scene. Do not synthesize a missing narration or mark the turn complete. |
| Open clarification | Reject progression; preserve the clarification and current scene. A later resolved action may propose again. |
| Active combat | Reject progression; combat remains authoritative. Combat ending alone does not advance the scene; a later eligible turn must propose. |
| Concurrent or stale proposal | Serialize; accept at most one. A proposal whose source is no longer current is a no-op/error, never a second transition. |
| Duplicate retry after commit | Return the original outcome based on the private internal request/commit identity; do not duplicate events, summaries, or player updates. |
| Crash before atomic commit | Recover the old scene and permit retry; no partial transition is observable. |
| Crash after commit/before response or push | Recover the new scene; reconnecting seats receive it through StateSync projection without replaying a scene-change message or applying a second transition. |
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
3. Positive paths: eligible resolved turn with committed narration closes a terminal scene; valid authored successor advances to that successor; omitted branch uses the documented authored default. Assert state and canonical event agree. Cover the legacy leave-judge `close_scene` route and prove it is subject to the same authoritative gate (including flag-off rejection).
4. Retry and concurrency: deliver the same action/transition twice, including concurrent requests, and prove one transition event, one summary identity, one state change, and one logical visible update. Reusing the private internal request/commit identity with altered source/target fails closed. A new action against an already-closed source cannot advance twice.
5. Restart recovery: restart after commit but before acknowledgment/push and verify StateSync projection restores the destination without replaying a scene-change message or duplicating the transition. Restart before commit and prove the source scene remains current and retry is safe.
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

## Addendum — atomic-commit feasibility precondition (2026-11-01)

**Open precondition; unverified.** The design above requires one durable atomic outcome spanning turn resolution, narration persistence, scene transition/state, and the durable player-visible update. Whether the existing persistence architecture can provide that boundary has **not** been verified. Do not treat the proposed single transaction as an established capability or begin implementation on that assumption.

Before any implementation card for ADR-042 (including card `5fd8ad52`) is started, inspect the live code and persistence paths and document the actual transaction boundaries and commit ordering for each of:

1. Turn resolution and `TurnResolved` persistence.
2. Narration persistence, including `NarrationCompleted` and the approved/held-output path.
3. Scene transition, `SceneClosed`, and resulting scene/completion state.
4. The player-visible update: its durable record/queueing boundary and its post-commit broadcast/delivery path.

Record whether these writes share one database transaction, which state is persisted versus in-memory, and where a crash or send failure can leave a partial outcome. In particular, distinguish atomically recording a player-visible update from delivering a network broadcast: delivery itself must not be claimed to participate in a database transaction unless the code and transport actually establish that guarantee.

If inspection proves one transaction can cover the required durable writes, update the implementation plan to name that transaction and its boundary. If it cannot, stop before implementation and resolve a follow-up design specifying a safe fallback, such as ordered durable writes with recovery idempotency based on the private internal request/commit identity, or a transactional outbox for the visible update. The fallback must preserve recoverable ordering, prevent duplicate transitions/notifications, and define restart behavior; do not weaken the invariant or substitute process-local state. The resulting design decision and revised acceptance/fault-injection cases must be recorded before implementation proceeds.

This feasibility check is a blocking prerequisite for **all** ADR-042 implementation cards, including schema/persistence, proposal/gating, transition, recovery, and player-update work. Mark the precondition complete only after source inspection has been recorded and the single-transaction design or fallback has been explicitly selected. Until then, ADR-042 remains a design proposal and atomicity remains unverified. This gate does not alter the feature-flag rule: `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` remains OFF by default and is enabled only by the exact string `true`, following ADR-038.

## Revision — Bastion design review (2026-11-01)

This revision is append-only. It clarifies/corrects the preceding proposal where it described existing behavior or a selected persistence design; all implementation cards remain **blocked** until the design and reconnect-projection open item below is resolved. The feature-flag rule above remains unchanged: default OFF, enabled only by the exact string `true`.

### Corrections to current-code description

The earlier statement that a scene summary is derived from an accepted committed transition does not describe current code. `ProductionSoloTurnRunner` calls `closeScene` while processing the generated result (`apps/server/src/room/productionTurnRunner.ts`); this persists the summary through `RegistryMemory.closeScene` in its own `BEGIN`/`COMMIT` transaction (`apps/server/src/dm/memory.ts`). The room's `writeTurn` transaction occurs later (`apps/server/src/room/Room.ts`). Thus a summary can persist even if the subsequent turn commit fails. The revised design requires summary generation/persistence only after the transition and turn have committed, or as a retryable derived step keyed by private internal request/commit identity. Add a fault-injection case where summary persistence succeeds and turn commit fails; the new design must make that ordering impossible, and prove retries do not create an orphan summary or duplicate one.

There is also an existing gap in canonical close semantics. The runner only rewrites a close into a transition when `adventure?.ok && closed.sceneId === initialSceneId` (`productionTurnRunner.ts`, around the `nextSceneAfterClose` call); `nextSceneAfterClose` returns `undefined` for an unknown scene or invalid successor (`packages/engine/src/adventure/transition.ts`), and that case is not raised as an error by the runner. `sceneCloseTool.ts` rejects a missing adventure and an invalid requested successor, but does not enforce source-scene equality. Consequently `SceneClosed` can still be committed without a valid scene transition. This is existing behavior, not the intended contract: the authoritative commit gate must reject missing adventure, source mismatch, unknown source, and invalid successor, and must never commit a `SceneClosed` without its corresponding valid transition/completion.

The existing `storyCombatFlagEnabled` parser correctly checks exact equality with `'true'` (`productionTurnRunner.ts`); this is the ADR-038 flag, not yet the ADR-042 rollout flag. However, the existing leave-judge `close_scene` path is unconditional and remains available independently of that flag. Therefore acceptance test 1's “no legacy ungated route” condition currently fails. The new ADR-042 flag must be checked again at authoritative commit time, not merely when exposing a proposal affordance, and no leave-judge/legacy path may bypass that gate.

### Selected transaction and delivery design

The preceding addendum's atomicity feasibility precondition is now resolved for durable turn state: `Persistence.writeTurn` is one transaction (`apps/server/src/persistence/index.ts`) that locks the session row `FOR UPDATE`, checks the lease fence, and atomically appends events and persists the resulting state/snapshot (and its supported narration/registry data). The room invokes it from the serialized turn commit path (`Room.ts`); it already carries the turn events, state/snapshot, and narration event. The selected design is to compute/validate the progression proposal inside that serialized authoritative commit path, include `SceneClosed` and resulting scene/completion state in the same `writeTurn` transaction, then generate/persist the scene summary after commit with idempotency based on private internal request/commit identity; `transitionKey` remains returned/persisted metadata only.

Network broadcast is not transactional: `Room.ts` broadcasts only after `writeTurn` returns. A durable event is therefore not by itself proof that each connected player received the visible update. The selected design does not replay scene-change messages. On reconnect, the authoritative `StateSync` projection provides current scene state; this matches ADR-040’s StateSync-only recovery model. Any live scene-change update is post-commit, while reconnect recovery replaces state from the projection.

**Reconnect scene-state recovery uses StateSync only.** Reconnecting seats receive current scene state from the authoritative StateSync projection, not replayed scene-change messages. This is state replacement, not message replay; no durable scene-change message record or replay authorization/deduplication protocol is required.

### Proposal authorization and party-turn resolution

A progression proposal is carried only by the account/seat that owns the originating accepted action; it is not a party-wide authorization inferred from narration. For a multi-seat party turn, resolve the party turn under the existing room serialization and evaluate at most the proposal attached to the authoritative action/turn being committed; proposals from other seats or actions are not merged or allowed to override its source/target. Add a negative test that a different seat cannot attach or replay a proposal under another seat's private internal request/commit identity, and assert no `SceneClosed`, summary, state change, or player update results.

### Required acceptance/fault cases and blocked status

In addition to the existing cases, require: (a) summary-persisted/turn-commit-failed ordering fault; (b) unknown/mismatched source, missing adventure, or invalid successor cannot commit `SceneClosed`; (c) exact-true flag still rejects the legacy leave-judge route unless it passes the same commit gate, and flag-off rejects at commit even if a proposal was exposed earlier; (d) the cross-seat authorization negative case above; and (e) after restart/reconnect, an eligible seat receives current scene state from the authoritative StateSync projection, including the committed currentSceneId and latest transition metadata where present; StateSync replaces the client projection and no scene-change message is replayed. Always project currentSceneId, including when the feature flag is OFF; the flag gates only the proposal affordance and authoritative commit. The gate reason is never put on the wire. Gate-outcome inference of hidden state is an accepted residual: depending on an open clarification, active combat, or held narration, other seats may infer that condition from a scene change or its absence. This is the same class of accepted visible-outcome residuals as ADR-040. It is not redesigned here. The remaining ADR-042 implementation gates continue to apply. This revision selects the existing `writeTurn` transaction for committed transition/state/narration data plus post-commit retryable summary; it does not claim network delivery is atomic.

### Verification record for this revision

Rechecked the cited runner, scene-close tool, transition helper, summary persistence, room turn commit/broadcast, persistence transaction, and room recovery paths in the PR worktree. `writeTurn` has session-row locking and lease fencing; the summary write is a separate transaction before room turn commit; broadcast occurs after commit. Scene-change message replay is not selected; reconnect recovery is through StateSync projection. No implementation code was changed.

## Addendum — reconnect scene projection and replay (2026-11-01)

This addendum records the verified current-code baseline and selected additive StateSync projection design. It does not change the proposal, transaction, or rollout decisions above. All implementation remains blocked behind `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION`, default OFF and enabled only by the exact string `true`.

### Verified current behavior

A reconnect is not an event-tail replay. `apps/server/src/gateway/ws.ts` passes `lastSeq = -1` and `requireExistingSeat: true` on join (lines 1111–1118); `Room.subscribe` sends `StateSync` when its sequence differs, followed by narration history, combat snapshot, seat-private round sync, and the reconnecting account's open clarification frames (`apps/server/src/room/Room.ts:1659–1680`). `clientSyncPayload` contains filtered `state`, bound seat IDs, and round data, but no scene id or closed-scene marker (`Room.ts:2012–2040`). Narration history carries turns with `turnId`, text, tier, and optional action text, is capped at 24,000 characters and hidden-entity scrubbed, and has neither scene identity nor `SceneClosed` (`Room.ts:1709–1759`).

The web client currently has no scene reducer: non-test `apps/web/src` contains no `sceneId` or `SceneClosed` handling. Thus a reconnecting seat today gets current room state and narration but cannot identify the current scene or learn that a scene closed while disconnected; old-scene narration may still appear in history. This is an actual replay gap, not merely an unverified assumption. There is no current scene-change reducer to double-apply, but any future reducer needs explicit idempotency semantics.

Two related assumptions are false in current code:

1. Summary persistence is a separate, earlier transaction than the room's `writeTurn`: `ProductionSoloTurnRunner` calls `closeScene` while processing the result (around `productionTurnRunner.ts:1487`), and `RegistryMemory.closeScene` begins its own transaction (`dm/memory.ts:395–398`); room turn persistence occurs later through `Room.writeTurn` (`Room.ts:1573–1584`). A summary can therefore survive a failed turn commit. The selected ADR design remains: commit the transition first, then produce/store its summary as a retryable derived step with idempotency based on the private internal request/commit identity.
2. A committed `SceneClosed` does not prove a valid transition. The runner rewrites the event only if `nextSceneAfterClose` returns a transition (`productionTurnRunner.ts:1466–1485`), while `nextSceneAfterClose` can return `undefined` for an unknown scene or invalid successor (`packages/engine/src/adventure/transition.ts:8–17`). The unrewritten close can remain in the event result. The authoritative commit must reject it; implementation must never persist a canonical `SceneClosed` without a valid successor or completion.

### Selected additive wire contract

Extend the existing `StateSync.payload` with a versioned `sceneProgression` projection that always includes `currentSceneId`, whether the ADR-042 flag is ON or OFF. The flag gates only the proposal affordance and authoritative commit; it does not gate projection of current scene state. The projection is built from the committed/recovered authoritative head, not runner-local state or narration:

- `currentSceneId`: exact id of the currently committed active scene; null only when the adventure is complete or no scene is active.
- `lastClosed`: null until a valid close has committed; otherwise `{ sceneId, transitionKey, currentSceneId, completed }` for the latest committed close. `transitionKey` is a server-random opaque token generated for that committed transition, independent of session/action identity and event ordering.

This is a snapshot, not a command or a request to re-run a transition. On commit, send the live StateSync update to every connected player after commit. The `StateSync` snapshot is authoritative and replaces the client's scene-progression view; `lastClosed` is informational and must not mutate `currentSceneId`. A client may identify a close by its opaque `transitionKey` (and local session context), but the key is not derived from that context. Reapplying an identical snapshot leaves the projected state unchanged; a later close replaces `lastClosed`. No reducer increments, advances, or toggles scene state from close metadata.

Projection safety is an allowlist: expose only the active/closed scene identifiers, opaque transition key, and completion bit. Do not serialize scene titles, summaries, successor lists, hidden authoring fields, model text/reasoning, registry/memory data, or any private seat data. Continue to apply the existing viewer-specific state projection and hidden-content policy. Do not reuse narration history to carry progression metadata. A reconnecting authorized seat receives only its own projection from the committed head. The expected live StateSync update is post-commit; failed/rejected transitions emit neither a close marker nor an advanced current-scene projection. Reconnect uses StateSync projection, not live-message replay.

The durable `SceneClosed` event plus recovered snapshot remains the source of truth for `currentSceneId` and latest close metadata; do not add a second mutable scene pointer or rely on process memory. Persist/recover the minimal projection inputs in the same `writeTurn` transaction as needed. On restart, reconnect `StateSync` replaces scene state from this projection; it does not replay a scene-change message. The transition key is opaque metadata, not an ordering cursor.

### Minimal implementation cards, tests first

Every card below is **blocked until its acceptance tests are written and pass in fixtures with the flag OFF and ON**. The sequence is intentional; do not expose a partial implementation or enable the flag during development rollout.

1. **Protocol and projection contract.** First add schema/server tests proving `StateSync` includes currentSceneId with the flag OFF and ON, includes latest close metadata when present, viewer projection excludes all non-allowlisted/hidden data, and projection replacement does not advance state. Then implement the payload type and authoritative projection from recovered committed state.
2. **Canonical close validation and durable marker.** First add runner/transaction tests proving unknown or mismatched source, missing adventure, invalid successor, summary-persisted/turn-commit-failed ordering, and stale/duplicate retries cannot create an orphan or invalid `SceneClosed`; prove valid transition/completion, state, and marker commit together in one `writeTurn`. Then route every close path through the flagged authoritative validation and persist/recover the opaque server-random transition key. Keep summary generation/storage after commit and enforce retry idempotency with the private internal request/commit identity; the transition key is returned/persisted metadata only.
3. **Reconnect projection and live delivery.** First add client tests for snapshot replacement, repeated StateSync projection, repeated live delivery, completion, restart/reconnect, and legacy payloads; assert one logical close and no second scene advance. Then consume `sceneProgression` as snapshot state and close metadata, and send any live update only after commit. Confirm reconnect receives current state from StateSync even if the live message was missed; do not replay scene-change messages.
4. **Flag and end-to-end recovery gate.** First add an integration test that turns the flag OFF after a proposal was formed and proves commit is rejected without close, summary, state advance, or marker; also test that currentSceneId is projected with the flag OFF and ON, and that StateSync restores committed scene state after restart/reconnect with the flag ON. Then wire the exact-`true` ADR-042 flag at both affordance and authoritative commit boundaries. Keep default OFF; no rollout or enablement is part of these cards.

These are the minimum slices: protocol projection, canonical durable close, consumer/live delivery, and flag/recovery integration. No implementation card may start before its own tests-first contract is present, and the feature remains blocked behind the OFF-by-default flag until the full acceptance set passes. This addendum does not authorize enabling the flag, changing unrelated event replay, or changing narration-history semantics.

### Verification record

Verified against the `sage/adr-042-replay-addendum` worktree at `origin/main` 912549c: `apps/server/src/gateway/ws.ts:1111–1118`; `apps/server/src/room/Room.ts:1659–1680, 1709–1759, 2012–2040, 1573–1584`; `apps/server/src/room/productionTurnRunner.ts:1466–1495`; `apps/server/src/dm/memory.ts:395–415`; `packages/engine/src/adventure/transition.ts:8–17`; and non-test search of `apps/web/src` for `sceneId`/`SceneClosed` (no matches). Documentation only; no tests run.

### Correction — keep the canonical close sequence off the wire (2026-11-01)

The canonical event sequence remains authoritative for persistence and internal recovery only; it is never included in `sceneProgression` or any other wire projection. `lastClosed` is exactly `{ sceneId, transitionKey, currentSceneId, completed }`. The server-random transition key is not derived from session/action identity or ordering; no session+key construction may reveal action identity or sequence.

`StateSync` remains an ADR-040 class-(b) current-cursor reply. Its outer wire envelope carries only the recipient's current viewer-local cursor, attached by the per-seat transmit layer; that cursor does not advance for StateSync and is not the close event's sequence. The ADR-042 `sceneProgression` payload contains no cursor of its own. Build it from committed/recovered authoritative state and reconstruct the latest marker internally from the durable event/snapshot data. If recovery needs the canonical close sequence, retain it only in internal persistence/recovery structures and remove it before serialization. Do not add canonical `seq`, `eventSeq`, global head, or another sequence-valued proxy to the payload. This keeps the durable SceneClosed event as the source of truth while complying with ADR-040's viewer-local-only wire contract.

The allowlist is therefore limited to `currentSceneId` and, when present, `lastClosed.sceneId`, `lastClosed.transitionKey`, `lastClosed.currentSceneId`, and `lastClosed.completed`. The existing default-OFF, exact-string-`true` flag rule and all previously stated blocked-implementation gates remain unchanged. Before any implementation card is unblocked, its protocol/recovery acceptance cases must verify that canonical event sequences remain internal, StateSync carries only its viewer-local current cursor, and repeated snapshots/live markers remain idempotent without using `transitionKey` as an idempotency input or relying on sequence ordering.


### Clarification — projection, gate residual, and opaque transition identity (2026-11-01)

This clarification supersedes any conflicting wording above. `StateSync` always projects the authoritative `currentSceneId`, including while the ADR-042 flag is OFF; the flag gates only the proposal affordance and authoritative commit. Gate reason/details are never put on the wire. Gate-outcome inference of hidden state is an accepted residual: depending on open clarification, active combat, or held narration, other seats may infer that condition from a scene change or its absence. This is the same class as ADR-040's accepted visible-outcome residuals and is not redesigned here.

Each committed transition receives a server-random opaque `transitionKey`, persisted with the committed transition. It is independent of session/action identity and sequence/order; it must not expose which action caused a transition or when it occurred. Internal commit/retry handling may use its private authoritative identity but must not encode that identity in this token.

Reconnect recovery is StateSync-only: reconnecting seats receive current scene state from the authoritative StateSync projection, which replaces their scene projection. No sequence-numbered scene-change record or message replay is used. `lastClosed` remains metadata in the projection and never advances state by itself. The feature flag remains default OFF and enabled only by exact string `true`.

## Addendum — deterministic progression triggers (2026-11-02, proposed)

This addendum proposes replacing model-invoked `close_scene` as the progression trigger; it does not authorize implementation. Its effect on the earlier rule that combat ending alone never advances a scene is narrowed and stated exactly in the 2026-11-03 addendum below (Decision 1).

### Trigger and ownership

Progression is an effect of committed authoritative state, never an LLM tool call or a text classifier. On the server's serialized turn/command path, evaluate the current scene's authored progression policy against committed facts: a terminal `CombatEnded` event for the scene's active encounter, or a server-produced `ObjectiveResolved` event for an authored objective. Only a matching authored trigger can close the scene. Combat outcome policy must be explicit in authored data, with no default outcome set (see the 2026-11-03 addendum's `allowedOutcomes`); objective completion must be a deterministic rules/command predicate. The model may narrate or suggest, but cannot assert either fact or select an un-authored target. Existing `nextSceneAfterClose` remains the deterministic successor selector: the first authored successor by default; no successor means adventure completion.

**Open domain prerequisite:** current `AdventureSceneSchema` has `nextSceneIds` but no objective definitions, and no `ObjectiveResolved` domain event exists. Before implementation, choose and validate the minimal authored objective predicate vocabulary and its authoritative producer. Do not infer objective completion from narration, player text, or an LLM judgment. Until that decision exists, only the combat-ended trigger is implementable; this proposal does not claim objective-trigger support is already deterministic.

### Commit, replay, and idempotency

The server owns trigger evaluation, source-scene validation, successor selection, and the resulting `SceneClosed`/scene-state transition. Evaluate only after the triggering fact is durable, under the room's serialized write path. Bind the transition to the durable trigger identity plus source scene; replaying the same trigger reconstructs the same closed/current scene state and cannot advance twice. A different trigger against a no-longer-current source is a no-op/conflict. `transitionKey` remains opaque response/projection metadata only and is not an idempotency key. Commit/recovery ordering must follow the unresolved ADR-042 atomic-commit feasibility precondition: do not claim a single transaction or start implementation until the actual event, state, summary, and notification write boundaries are verified and an atomic or recoverable/outbox design is selected. Generate summaries from the committed transition as retryable derived data, not as a prerequisite or an earlier side effect.

### Hidden-information safety

Evaluate against full authoritative server state, but disclose only the existing ADR-042 StateSync allowlist (`currentSceneId` and opaque `lastClosed` metadata). No scene title, destination title, or other authored scene text is added to the projection; any title exposure would require a separate ADR revision. Never project objective definitions, hidden trigger facts, gate reasons, internal trigger identity, or canonical event sequence. A public scene change can reveal that some gate fired; accept only the previously recorded ADR-040 class of visible-outcome inference, and ensure the projection does not reveal which hidden objective or entity caused it. Repeated StateSync snapshots replace client scene state; they are not replayed as transition commands.

### Failing-first acceptance tests (not run)

1. With a terminal `CombatEnded` fact for the active scene's encounter, prove one deterministic close/advance only when the outcome is in the objective's authored `allowedOutcomes` (victory and flee each tested listed and unlisted; defeat never resolves); unrelated combat end, nonterminal combat state, or a stale source scene does not advance.
2. For each authored objective predicate, prove its server-side condition emits/resolves exactly once; near-miss state, narration claiming success, quoted player instructions, and model-supplied `ObjectiveResolved` data do not advance. Missing/invalid objective definitions fail adventure validation.
3. Prove successor selection is authored-only, default ordering is deterministic, terminal scenes complete, and invalid/missing scenes never persist `SceneClosed` without a matching state transition.
4. Replay the same durable trigger across duplicate delivery and process restart: one logical transition/summary/notification; a distinct trigger on the now-closed source cannot advance again. Inject failure at each actual persistence boundary and prove recovery yields either the old or the fully committed outcome, including notification/outbox behavior.
5. For every seat, assert projected state contains only the ADR-042 allowlist (no scene or destination title); hidden objective/encounter identifiers, trigger cause, canonical sequence, and gate reason are absent. Repeated snapshots replace state without applying another transition.

**Implementation remains blocked** until (a) the objective data model/producer is decided and (b) the pre-existing ADR-042 atomic-commit feasibility precondition is completed. This is a design proposal, not a rollout authorization; the ADR-042 flag remains default OFF.

## Addendum — authored objectives and commit feasibility resolved (2026-11-03, proposed)

Append-only. This resolves the two blockers recorded in the deterministic-trigger addendum above: (a) no authored objective model or `ObjectiveResolved` producer, and (b) the open atomic-commit feasibility precondition. It narrows that addendum where they conflict. The flag rule is unchanged: `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` is default OFF and enabled only by the exact string `true`.

### Decision 1 — one authored concept: the scene objective

Combat and non-combat progression use one concept. An encounter outcome is an objective; a combat ending does not close a scene directly. Every close therefore goes through one evaluator and one event path.

**Scope of the supersession.** The earlier rule "combat ending alone never advances a scene" (Failure behavior, "Active combat") is superseded only in one case: a scene with an authored `encounter` objective whose `allowedOutcomes` lists the committed outcome. In every other case it is unchanged. A combat end with no matching authored encounter objective, or with an outcome that objective does not list, does not advance the scene.

Add to `AdventureSceneSchema` (`packages/schema/src/adventure.ts`):

```ts
const ObjectiveBase = {
  id: z.string().min(1),                           // unique across the adventure
  nextSceneId: z.string().min(1).optional(),       // must be in the scene's nextSceneIds
};
export const AdventureObjectiveSchema = z.discriminatedUnion('kind', [
  z.object({ ...ObjectiveBase, kind: z.literal('encounter'),
    encounterId: z.string().min(1),                // must be in the scene's encounterIds
    allowedOutcomes: z.array(z.enum(['party-victory', 'enemies-fled'])).min(1) }).strict(), // required; no default
  z.object({ ...ObjectiveBase, kind: z.literal('check'),
    ability: AbilitySchema, skill: SkillSchema.optional(),
    dc: z.int().min(5).max(30) }).strict(),
]);
// AdventureSceneSchema gains:
objectives: z.array(AdventureObjectiveSchema).default([]),
completion: z.enum(['any', 'all']).default('any'),
```

There are exactly two predicates, and each resolves from facts the server already owns:

- **`encounter`** resolves when the room combat state for that encounter has `ended.outcome` in the authored `allowedOutcomes`. `allowedOutcomes` is required and has no default: `enemies-fled` counts as completion only when the author lists it, and `party-victory` likewise. The outcome comes from `combatOutcome` (`apps/server/src/room/combatEngine.ts:150–157`), a pure function of entity HP and liveness. `party-defeated` cannot be authored, because the TPK resolution flow (`Room.chooseTpkResolution`) owns that outcome. `dm-ended` (`combatBootstrap.ts:516`, emitted when the model clears engine combat) is never a resolving outcome, because it is a model assertion and not a rules result.
- **`check`** resolves when the server rolls a success against the **authored** ability, skill, and DC. The existing `request_check` tool takes `dc` and `advantage` from the model (`packages/engine/src/tools/check.ts:34–42`), so it cannot resolve an objective. Add one DM tool, `attempt_objective({ objectiveId, actorId })`. It accepts only an objective id offered for the current scene and an actor in the session. It reads ability, skill, and DC from authored data, rolls through the existing `abilityCheck`, and ignores any model advantage (conditions still apply). It emits the normal `RollEvent` plus `ObjectiveAttempted { objectiveId, success }`. The model decides *when* to attempt, the same way it decides when to call `start_combat` with an authored encounter key. The server decides the outcome.

Validation, added to `validateAdventure` (`packages/engine/src/adventure/validate.ts`): objective ids are unique across the adventure; `encounterId` belongs to the same scene's `encounterIds`; `nextSceneId` belongs to the same scene's `nextSceneIds`; a scene with `completion: 'all'` has at least one objective. A scene with no objectives cannot progress while the flag is ON. That is intentional: progression requires authored intent. See "Needs Chris" for adventure #1 content.

**Successor selection** stays inside `nextSceneAfterClose`. The evaluator passes the `nextSceneId` of the objective that satisfied completion. If several objectives resolve in the same commit, the first one in authored array order wins. When that objective has no `nextSceneId`, selection falls back to the authored default (`nextSceneIds[0]`), and an empty `nextSceneIds` completes the adventure. The server never selects a successor from model text.

### Decision 2 — `ObjectiveResolved` has exactly one producer

```ts
ObjectiveResolved: { type: 'ObjectiveResolved', sceneId, objectiveId,
                     cause: 'encounter-ended' | 'check-succeeded' }   // .strict()
```

Only the room progression evaluator produces it, at the commit seam below. No tool executor emits it. `Room` drops any `ObjectiveResolved` or `SceneClosed` in a runner `result.events`. That makes model-originated or forged events impossible by construction, with no need to verify their provenance. `ObjectiveAttempted` is an input fact. The evaluator re-validates it before resolving: the objective must belong to the *current* scene, must be unresolved, and the attempt must have succeeded.

Progress lives in the snapshotted game state as `resolvedObjectiveIds: string[]`, next to the existing `sceneId`/`adventureCompleted` fields (`productionTurnRunner.ts:111–128`). Room combat state gains `encounterId` and `sceneId`, set when `start_combat` succeeds. Today the encounter key reaches only `resolvedEncounters`, which records encounter *starts* (`productionTurnRunner.ts:757–763`), so a `CombatEnded` cannot currently be tied to an authored encounter. These are additive optional fields; legacy snapshots parse unchanged.

**Replay.** Snapshots carry `sceneId`, `resolvedObjectiveIds`, and `lastClosed`. The event log carries `ObjectiveResolved` and `SceneClosed` in the same turn as the state change. Recovery through `recoverRoom` and the latest snapshot therefore restores progression without re-evaluating anything. Rewind restores the prior snapshot, which un-resolves objectives and un-closes the scene together. `writeTurn` already deletes the scene summary for a reverted turn in the same transaction (`persistence/index.ts:615–623`).

**Idempotency** follows from state, not from a key. An objective resolves only if it is absent from `resolvedObjectiveIds`. A scene closes only if `sceneId` still equals the source. Both checks run under the room mailbox and the `writeTurn` session-row lock plus lease fence. A duplicate delivery is rejected earlier by the existing `actionIds` dedupe in the snapshot. `transitionKey` stays opaque metadata and is never an idempotency input.

**Hidden information.** `ObjectiveAttempted`, `ObjectiveResolved`, and the new combat-state fields are server-only. Add them to the visibility table as send-to-no-one, which is the existing fail-closed default for unlisted types (`eventVisibility.ts:1–5`). Objective definitions go to the DM prompt for the current scene only, like encounter keys today; they never go to the client. The player-visible surface is unchanged from the earlier addenda: the normal roll display for the attempt, plus the `sceneProgression` StateSync allowlist, which is unchanged: scene ids, opaque `lastClosed` transition metadata, and the completion bit. No scene or destination title is projected; this also governs the earlier "Player experience" wording about naming the destination by title. Any title exposure would require a separate ADR revision. The accepted inference residual is the same as before: a scene change shows that some authored gate fired, but not which one.

### Decision 3 — feasibility settled: one existing transaction covers the durable outcome

Verified against `origin/main` 2fb099e (repowise `get_context` on `Persistence.writeTurn`, `Room.ts`, and `transition.ts`, index at 956fbb7, then confirmed in source):

1. `Persistence.transaction` (`apps/server/src/persistence/index.ts:150–191`) opens one `BEGIN`, locks the session row `FOR UPDATE`, locks and checks the `session_lease` fence, runs the work, and then commits or rolls back. `writeTurn` (`:428–678`) runs inside it: registry events, `appendEvents`, the reverted-summary delete, and `insertSnapshot` all share that client.
2. The exploration and combat-narration commit is one `writeTurn` call (`Room.ts:6396–6404`), made inside `this.enqueue` (`:5987`). Its `writes` already contain the runner's events, `NarrationCompleted` and `ActionAccepted` (`:6056–6073`), combat events from `combatRuntime.reconcile`, `NarrationCommitted` for a combat turn (`:6252–6258`), and `GameStateCommitted` (`:6377–6382`). The snapshot it writes carries the full next game state.
3. `CombatEnded` from a rules outcome commits **earlier**, in `commitCombat`'s own `writeTurn` (`Room.ts:6659`, write at `:6758`). The final combat turn's narration is then queued and committed later through step 2 with `combatTurnId`. This is acceptable: `CombatEnded` is an *input* fact that is already durable, and the progression outcome (`ObjectiveResolved` + `SceneClosed` + new state) does not need to share its transaction.
4. Broadcast happens after `writeTurn` returns (`Room.ts:6405–6510`). On a write failure, `withCommittedHeadRecovery` reloads seq and state from storage (`:1594–1613`), so the in-memory head the evaluator reads equals the committed head for the leaseholder.

**Selected design.** The evaluator runs inside the step-2 commit, after `writes` and `nextState` are built and before `writeTurn`. It appends `ObjectiveResolved…` and, when completion is met, a server-built `SceneClosed`, and it patches `sceneId`/`adventureCompleted`/`resolvedObjectiveIds`/`lastClosed` into the snapshot. That single existing transaction makes the durable outcome atomic. No outbox and no new table are needed.

- **Summary** is moved out of the runner. Today `closeScene` commits its own transaction *before* the room commit (`productionTurnRunner.ts:1487–1504`, `dm/memory.ts:395–415`). Under the new design it becomes a post-commit derived step keyed by the committing turn id, which is the private commit identity and is already stored as `scene_summaries.turn_id`. It is already idempotent through the unique `(session_id, scene_id)` index with `ON CONFLICT DO NOTHING` (`migrations/0015`). Recovery needs no queue: on room load and after each commit, any committed `SceneClosed` without a summary row is retried. A failed summary never affects progression. The server-built `SceneClosed` carries no model-written `summary` field. The current schema requires one (`packages/schema/src/dm-events.ts:63–70`); make it optional, so that legacy events still parse.
- **Delivery** stays post-commit StateSync. Reconnect recovery uses the StateSync projection, as already decided. A network send is not claimed to be transactional.

**Gates, restated against real events.** The evaluator runs only when this commit contains a non-fallback `NarrationCompleted` for the action; it is not a clarification turn (`result.clarification` unset); `moderationHeld` is false; `openClarifications` is empty after the commit; no combat is active (no `combatRoom`, or `combatRoom.ended`); the flag is ON; and the adventure loaded. If any gate fails, nothing is emitted. **A trigger is deferred, not lost:** resolution reads committed state (`combatRoom.ended` plus its `encounterId`, or the commit's `ObjectiveAttempted`), so a combat whose final narration was held or hit the fallback (`commitCombatFallback`, `Room.ts:3133`, which never runs the evaluator) still resolves the encounter objective at the next eligible commit. A failed `ObjectiveAttempted` resolves nothing and can be attempted again later.

This **marks the atomic-commit feasibility precondition complete** for the durable outcome. Other `writeTurn` callers (`commitGameState`, TPK/checkpoint paths, seat/presence `persist`) never run the evaluator and cannot close a scene.

**Pre-existing gap noted, not fixed here.** `sceneBoundaryPending` (`Room.ts:918`, set at `:6407`) is process-local, so a restart between a close and the next turn drops that late-join boundary. Slice 3 below derives it from `lastClosed` instead.

### Ordered implementation plan (card-sized, tests first)

Every slice is flag-gated and default OFF. Each lands with its failing tests first, and each is mergeable alone.

1. **Schema + validation.** Add `AdventureObjectiveSchema`, the scene `objectives`/`completion` fields, the `ObjectiveAttempted`/`ObjectiveResolved` schemas, an optional `SceneClosed.summary`, and the validation rules. Tests: valid and invalid authored data (duplicate id, foreign encounter, foreign successor, `party-defeated`/`dm-ended` rejected, missing or empty `allowedOutcomes` rejected); legacy adventure and legacy `SceneClosed` still parse. *No runtime change.*
2. **Pure evaluator** in `packages/engine/src/adventure/progression.ts`: `evaluateProgression(adventure, gameState, turnFacts) → { events, statePatch }`, with no I/O and with `nextSceneAfterClose` inside it. Tests: encounter outcome matrix (each outcome listed and unlisted in `allowedOutcomes`; an unlisted `enemies-fled` does not resolve), check success and failure, stale source scene, already-resolved objective, `any` versus `all`, same-commit authored-order tie-break, terminal completion, invalid successor (no close).
3. **Room commit seam.** Record `encounterId`/`sceneId` on combat state at `start_combat`. Behind the flag, strip runner `ObjectiveResolved`/`SceneClosed`, apply the gates, call the evaluator, extend `writes` and the snapshot in the step-2 `writeTurn`, generate `transitionKey`, set `lastClosed`, and derive the late-join scene boundary from it. Tests: the gate matrix (each gate failing alone means no events and no state change); the deferred-trigger case (held or fallback final narration, then resolution on the next commit); a forged runner `ObjectiveResolved` dropped; a fault injected inside `writeTurn` rolls back all progression; duplicate action and restart recovery produce one transition.
4. **`attempt_objective` tool.** Offer the tool only with the flag ON and only for the current scene's unresolved `check` objectives. Authored DC, no model advantage. Tests: unknown/foreign/resolved objective rejected; the model cannot pass a DC or advantage; a success resolves exactly once.
5. **Summary relocation + legacy cutover.** With the flag ON, remove the `close_scene` affordance and the runner's pre-commit `closeScene` call; run the post-commit idempotent summary plus the on-load retry. Tests: summary failure leaves the scene advanced; the orphan-summary ordering (summary persisted, turn commit failed) is impossible; retry writes one row; rewind removes it.
6. **Projection + client** (the earlier addendum's cards 1 and 3, unchanged): `sceneProgression` in StateSync, and a client reducer that replaces state from snapshots.
7. **Adventure #1 content.** Author objectives for every scene of `adventure:01-hollow-under-marrowfell`, then run an end-to-end flag-ON play-through fixture. This slice is blocked on the content decision below.

Slices 1, 2, and 4's tool schema can proceed in parallel. Slice 3 depends on 1 and 2. Slice 5 depends on 3. Slice 7 gates any flag enablement.

### Decision 4 — flag-OFF keeps the legacy path (decided by Chris)

While `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` is OFF, the legacy `close_scene` path is unchanged from current behavior. It is removed only when the flag is ON, where every close goes through the evaluator and commit seam above. This supersedes the earlier flag-OFF wording ("Feature flag": reject and do not fall through to the legacy path; "Consequences": feature-off sessions cannot progress; acceptance test 1 and revision case (c): no legacy ungated route with the flag OFF). With the flag ON those requirements still hold: no legacy or leave-judge route may bypass the gate, and the flag is re-checked at commit. Slice 5 tests both settings: flag OFF leaves legacy `close_scene` behavior unchanged; flag ON removes it.

### Needs Chris

1. **Adventure #1 objectives.** Choose which encounter outcome or authored check completes each scene, which `allowedOutcomes` each encounter objective lists, and which branch each one selects. This is design and content work, not engineering.

### Verification record

Source read in the worktree at `origin/main` 2fb099e plus this branch: `apps/server/src/persistence/index.ts:150–191, 428–678`; `apps/server/src/room/Room.ts:918, 1381–1392, 1581–1613, 3133–3224, 5987–6512, 6659–6760, 6947–6990`; `apps/server/src/room/productionTurnRunner.ts:111–128, 368–395, 745–770, 1050–1063, 1430–1530`; `apps/server/src/room/combatEngine.ts:150–190`; `apps/server/src/room/combatBootstrap.ts:500–518`; `apps/server/src/room/eventVisibility.ts:1–30`; `packages/engine/src/tools/check.ts`; `packages/engine/src/adventure/{transition,validate}.ts`; `packages/schema/src/{adventure,events,dm-events}.ts`; `apps/server/src/dm/memory.ts:390–420`; `apps/server/migrations/0015_scene_summary_idempotency.sql`. Repowise `get_context` was used for orientation (index 956fbb7); every claim above was confirmed in source. This is a documentation-only change, and no tests were run.

## Revision — Bastion security review of the 2026-11-03 addendum (2026-11-03, proposed)

Append-only. This revision answers Bastion's NO-GO on the 2026-11-03 addendum (eight findings). Where it conflicts with that addendum or anything earlier, this revision wins. The flag rule is unchanged: `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` is default OFF and enabled only by the exact string `true`.

### R1 (High) — `attempt_objective` gets one attempt, made by the acting seat

**One attempt per objective per scene.** The first committed attempt spends the objective, whether it succeeds or fails. A failed objective cannot be attempted again in that scene. There is no authored retry count in this revision. Snapshotted game state replaces the `ObjectiveAttempted`-as-input idea with `objectiveAttempts: Record<objectiveId, 'succeeded' | 'failed'>`, written in the same `writeTurn` as the turn that made the attempt. That write happens whatever the narration gates decide, so a successful attempt whose narration was held or fell back is recorded, and it resolves at the next eligible commit. This is the same deferral that encounter objectives get. The evaluator resolves a check objective only when it is `'succeeded'` in `objectiveAttempts` and is absent from `resolvedObjectiveIds`. Rewind restores the earlier snapshot, so it un-spends attempts together with everything else. Rewind is already an authoritative host action and is not a re-roll vector the model can reach.

The tool rejects an attempt, without rolling, when the objective is not an unresolved `check` objective of the current scene or already appears in `objectiveAttempts`. It also rejects a second `attempt_objective` call in the same turn, using the same single-use pattern as `start_combat`'s `attemptState.startCombatCalled` (`productionTurnRunner.ts:838–847`). A turn that does not commit never spends the objective. Its roll must come from the committed RNG seed, so retrying the same action reproduces the same roll; a commit failure cannot be used to re-roll.

**Dead-end authoring rule.** Spend-on-failure means a scene can become unable to progress. `validateAdventure` therefore rejects (a) a `completion: 'all'` scene that contains any `check` objective, and (b) a `completion: 'any'` scene whose objectives are all `check` objectives. Each scene must keep an encounter path, or a mix of objectives, that a failed check cannot close off. A fail-forward successor such as `onFailureNextSceneId` is out of scope. See "Needs Chris" item 2.

**Actor binding.** The tool schema is `attempt_objective({ objectiveId })`. The model does not supply an actor. The server sets the actor to the character bound to the seat whose accepted action is being resolved (`actors[request.accountId]`, the same binding behind the existing `otherSeatIds` guard at `productionTurnRunner.ts:647–649, 945–951`). If any `actorId`, `dc`, `advantage`, or `skill` key is present, the call fails with `schema-violation` (strict schema). An NPC, another seat's character, or an unseated entity can never be the actor.

**Not during combat.** `attempt_objective` is rejected with `illegal-transition` while combat is active, meaning `combatRoom` exists without `ended`, or engine combat has initiative. The tool is not offered on combat turns. Checks during combat stay on the existing combat rules path, and encounter objectives cover combat progression.

Acceptance tests (add to slice 4):
- A failed attempt spends the objective. A second attempt on that objective in the same scene, on the same turn or a later one, is rejected without a roll, and `objectiveAttempts` and the RNG state stay unchanged.
- A second `attempt_objective` call in one turn is rejected.
- A turn commit failure after an attempt leaves the objective unspent, and retrying the same action yields the identical roll.
- A success under held or fallback narration is recorded and resolves at the next eligible commit, exactly once.
- Any call carrying `actorId`, `dc`, `advantage`, or `skill` is rejected. In a two-seat party, seat B's accepted action rolls with seat B's character; it can never roll for seat A's character or for an NPC.
- The call is rejected during active combat.
- Validation rejects both dead-end shapes above.

### R2 (High) — the attempt's wire roll carries no DC, reason, or objective label

**Verified current behavior.** `RollEvent` (`packages/schema/src/events.ts:24–36`) carries `label`, `dc`, and `success`, and its schema is not strict. Its visibility rule masks only hidden entity ids (`eventVisibility.ts:30`). For a player character actor, the event therefore reaches every seat. `toWireEvent` (`combat.ts:735–786`) keeps `dc`/`success` on breakdown events and returns any other event unchanged (`{ ...event }`), so a `dcReason` or other extra field on a live `RollEvent` would pass through to `Room`'s per-viewer broadcast (`Room.ts:5904–5944`). The web client already renders `dc` and `dcReason` from the payload (`apps/web/src/features/narration/NarrationLog.tsx:54–63`, `RollBreakdown.tsx:18–60`). Today `request_check` emits no structured `RollEvent`. Its executor returns `{ result, rng }` without `events` (`check.ts:110–114`), so `executeTool` forwards `output.events = []` (`orchestrator.ts:378–395`). The only DC disclosure today is the model-facing tool summary `… vs DC N …` (`check.ts:113`), which the model can repeat in narration. The 2026-11-03 sentence "It emits the normal `RollEvent`" would therefore create a new channel that sends `dc`, `dcReason`, and `label` to all seats. That sentence is superseded.

**Decision.** The attempt persists one server-only internal roll record, `ObjectiveRoll { objectiveId, actorId, total, autoFail, breakdown }`, which is send-to-no-one. It produces exactly one player-visible roll. That roll is built from an allowlist, and passing the internal event through is not allowed:

`{ type: 'RollEvent', actorId, label, dice, rolls, modifier, total }`

Here `label` is the skill's display name, or the ability's when there is no skill (for example `"Athletics check"`). It never contains the objective id or any authored text. The wire roll omits `dc`, `dcReason`, `success`, `breakdown.dc`, and any objective-naming field. `success` is omitted because, together with `total`, it bounds the hidden DC; the narration states the outcome. The model-facing tool summary says only success or failure, without the DC or the total. Objective definitions in the DM prompt give the id, ability, and skill, but not the DC. `abilityCheck` requires a non-empty `dcReason` (`checks.ts:40–43`), so the server passes a fixed internal constant that never leaves the server.

Acceptance tests (slice 4): for every seat, including the actor's, the live and persisted-replay wire roll for an attempt has exactly the allowlisted keys, and `dc`, `dcReason`, `success`, the objective id, and the authored DC value are absent from the frame. The tool summary given to the model contains no DC and no total. The narration-history and StateSync payloads contain no objective id.

### R3 (Med) — the runner `SceneClosed` strip applies only with the flag ON

Supersedes "`Room` drops any `ObjectiveResolved` or `SceneClosed` in a runner `result.events`" (Decision 2) and slice 3's "strip runner `ObjectiveResolved`/`SceneClosed`" wording. With the flag OFF, `Room` does not touch a runner `SceneClosed`, and legacy `close_scene` behaves exactly as it does today (Decision 4). With the flag ON, `Room` drops every runner `SceneClosed`, and the evaluator is the only producer. Runner-supplied `ObjectiveResolved`, `ObjectiveAttempted`, and `ObjectiveRoll` (see R4) are dropped in both modes, because none of them has a legitimate legacy producer. Tests (slice 3 and slice 5): with the flag OFF, a legacy `close_scene` result commits its `SceneClosed` and transition unchanged, and runner `ObjectiveResolved`/`ObjectiveAttempted` are dropped. With the flag ON, a runner `SceneClosed` is dropped and nothing closes without the evaluator.

### R4 (Med) — `Room` derives attempt success itself

`Room` drops any runner-supplied `ObjectiveAttempted`. It never reads a success boolean from an event. The runner's `attempt_objective` executor hands the commit only the internal `ObjectiveRoll` from R2. At the commit seam, `Room` re-validates that roll against authoritative data:

1. `objectiveId` is a `check` objective of the committed current scene, and it is absent from both `objectiveAttempts` and `resolvedObjectiveIds`.
2. `actorId` equals the character bound to the committing action's seat.
3. There is exactly one `ObjectiveRoll` in the commit.

`Room` then computes `success = !autoFail && total >= dc`, using the DC it looks up itself from the loaded authored adventure. `Room` writes `objectiveAttempts[objectiveId]` and its own server-only `ObjectiveAttempted { objectiveId, success }`. A roll that fails validation is dropped: no attempt is recorded and no objective is spent. Tests (slice 3):
- A forged runner `ObjectiveAttempted { success: true }` with no roll resolves nothing.
- An `ObjectiveRoll` whose total is below the authored DC records `'failed'`, even if the runner's event says otherwise.
- An `ObjectiveRoll` for another seat's actor, a foreign-scene objective, or a duplicate roll is dropped.

### R5 (Med) — encounter resolution reads only room combat state

The evaluator resolves an `encounter` objective only from the authoritative room state `combatRoom.ended.outcome`, together with the `combatRoom.encounterId`/`sceneId` recorded at `start_combat`. It never reads a `CombatEnded` event from `result.events`, the commit's writes, or the event log. This supersedes the 2026-11-02 trigger wording ("a terminal `CombatEnded` event"). Only `settle` sets `combatRoom.ended` (`combatEngine.ts:184–188`), from `combatOutcome`. The model-driven `dm-ended` path emits a `CombatEnded` event and deletes `combatRoom` instead of setting `ended` (`combatBootstrap.ts:510–517`). That path can therefore never resolve an encounter objective, and its encounter is already spent in `resolvedEncounters`. An author should not rely on an encounter objective as a scene's only path out if the DM is likely to end that encounter by hand; the R1 dead-end rule covers check objectives only. Tests (slice 2 and slice 3):
- A forged or tool-emitted `CombatEnded { outcome: 'party-victory' }` with no matching `combatRoom.ended` resolves nothing.
- A `dm-ended` combat resolves nothing.
- A `combatRoom.ended` whose `encounterId` or `sceneId` differs from the objective's resolves nothing.

### R6 (Med) — line 42's title wording is superseded

The "Player experience" section (line 42) said to name the destination "using its player-safe authored title" and to "refresh scene-specific objectives/context". Both are explicitly superseded. No scene title, destination title, objective, or authored scene text goes on the wire for progression. The only player-visible progression data is the `sceneProgression` allowlist, with R7's aliases. The client shows a fixed generic message, such as "The scene has changed" or "The adventure has ended", driven by `lastClosed`/`completed`. The destination is introduced only by normal moderated DM narration on a later turn. Objectives are never projected to clients. "Refresh scene-specific context" applies only to the server-side DM prompt.

### R7 (Low) — scene ids on the wire are opaque aliases

Authored scene ids such as `scene:ambush-at-the-mill` can be spoilers. `currentSceneId`, `lastClosed.sceneId`, and `lastClosed.currentSceneId` are therefore never the authored id on the wire. The projection emits `sceneRef = base64url(HMAC-SHA256(serverKey, sessionId ‖ authoredSceneId))`, truncated to 22 characters. Because it is derived from a key, it needs no new storage and stays stable across restarts and reconnects for that session. It can't be reversed or guessed without the server key, and each session gets different aliases. Clients may only compare it for equality. Authored ids stay internal, in events, snapshots, and the prompt. Rotating the key changes the aliases; that is acceptable because StateSync replaces the client's scene view. The allowlist keys are unchanged; only their values are aliases. Pre-existing and out of scope: `CombatStarted.encounterId` is in the wire schema (`events.ts:41–46`) and its visibility rule does not strip it. I did not verify whether it is populated today. The new combat-state `encounterId`/`sceneId` fields stay server-only. Test (slice 6): for every seat, no StateSync or live frame contains an authored scene id. The alias is stable across reconnect and restart and differs between two sessions of the same adventure.

### R8 (Low) — `enemies-fled` includes mixed kill-and-flee endings

`combatOutcome` (`combatEngine.ts:150–156`) returns `party-victory` only when every enemy has `hp <= 0`. When no enemy is left standing but at least one fled instead of dying, it returns `enemies-fled`, even if the rest were killed. An objective that lists only `party-victory` therefore does not resolve if a single enemy flees. Authoring guidance: for "the party overcomes this encounter", list both `party-victory` and `enemies-fled`. List only `party-victory` when the story needs every enemy dead, for example when a survivor would raise the alarm, and accept that a flee then leaves that objective unresolved. Use separate objectives with different `nextSceneId`s when the two endings should branch. The engine does not add a partial-kill outcome. Slice 2's outcome matrix adds a mixed case: one enemy killed and one fled yields `enemies-fled`, and it resolves only an objective that lists `enemies-fled`.

### Needs Chris (additions)

2. **Fail-forward.** Under R1, a failed check spends its objective, and validation rejects scenes where that could leave no path out. Decide whether a later revision should add an authored failure successor so check-only scenes can be written.

### Verification record

Source read in the branch worktree at d395d56:
- `packages/schema/src/events.ts:15–46`
- `packages/engine/src/tools/check.ts:22–115`, `packages/engine/src/tools/{index,result}.ts`, `packages/engine/src/combat/checks.ts:20–100`
- `apps/server/src/dm/orchestrator.ts:341–395, 790–810`
- `apps/server/src/room/productionTurnRunner.ts:647–653, 780–1070`
- `apps/server/src/room/eventVisibility.ts:1–80`, `apps/server/src/room/combat.ts:728–786`, `apps/server/src/room/Room.ts:5890–5944`, `apps/server/src/room/combatEngine.ts:149–188`, `apps/server/src/room/combatBootstrap.ts:505–518`
- `apps/web/src/features/narration/NarrationLog.tsx:47–63`

Repowise was not used; I read the files directly. Documentation-only change, no tests run.

## Revision — Sentinel dead-end and Bastion round-2 findings (2026-11-03, proposed)

Append-only. This revision answers Sentinel's NO-GO (a scene can become unable to progress) and Bastion's NO-GO on the R1–R8 revision. The decisions below were made by Atlas under Chris's delegation. Where this revision conflicts with anything above, this revision wins. The flag rule is unchanged: `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` is default OFF and enabled only by the exact string `true`.

### L1 — every scene has a guaranteed-liveness path (Sentinel)

**What this guarantees.** No committed state can leave a scene unable to progress. It does not guarantee that the model takes the open path; the model still decides when to start combat or attempt a check.

**Schema addition.** A `check` objective gains an optional authored fail-forward successor:

```ts
// added to the 'check' member of AdventureObjectiveSchema
onFailure: z.object({ nextSceneId: z.string().min(1) }).strict().optional(), // must be in the scene's nextSceneIds
```

When a check objective with `onFailure` is spent by a failed attempt (`objectiveAttempts[id] === 'failed'`), the evaluator resolves it with `ObjectiveResolved { cause: 'check-failed-forward' }`, and successor selection uses `onFailure.nextSceneId` for that objective. Everything else about progression is unchanged. The server evaluates it at the same commit seam, under the same gates and the same flag, from snapshotted `objectiveAttempts`. A held or fallback narration defers it in the same way as a success. The model cannot choose the failure branch: the outcome comes from the server's roll (B1, C1). Add `'check-failed-forward'` to the `ObjectiveResolved.cause` enum.

**Live objective.** An objective is *live* when no committed outcome can spend it without resolving it:

1. an `encounter` objective whose `allowedOutcomes` contains both `party-victory` and `enemies-fled`, whose `encounterId` appears in no other scene's `encounterIds`; or
2. a `check` objective with `onFailure`.

**Validator rule.** Add a progression mode to `validateAdventure` (`packages/engine/src/adventure/validate.ts`). With the flag ON, the room loads an adventure for progression only if it passes this mode. An adventure that fails is refused at load with an operator diagnostic, so no session can start on it and later strand. The flag-OFF validation is unchanged, and legacy adventures without objectives still parse. In progression mode:

- every scene has at least one objective;
- a `completion: 'any'` scene has at least one live objective;
- in a `completion: 'all'` scene, every objective is live;
- the scene graph formed by `nextSceneIds` is acyclic, because a re-entered scene would find its objectives already spent.

This replaces R1's two dead-end shapes ((a) and (b)) and its "an encounter path, or a mix of objectives" sentence. A mix is not a guarantee. It also replaces R5's author-guidance sentence ("An author should not rely on an encounter objective…"), Decision 1's "A scene with no objectives cannot progress while the flag is ON. That is intentional", R1's "A fail-forward successor such as `onFailureNextSceneId` is out of scope", and R8's "accept that a flee then leaves that objective unresolved" as a way out of a scene. An objective that lists only `party-victory` is still valid, but it is not live and cannot be a scene's only path. Adventure #1 is linear and has no shared encounter keys (`packages/engine/adventures/01/adventure.json`). Its four encounter-free scenes will each need a check objective with `onFailure` (see "Needs Chris").

**Combat endings that are not rules outcomes do not spend the encounter.** Today `start_combat` adds the key to `resolvedEncounters` when combat *starts* (`productionTurnRunner.ts:757–763`). `offeredEncounters`/`resolveEncounter` then refuse it (`apps/server/src/dm/encounters.ts:88`, `ENCOUNTER_ALREADY_USED` at `productionTurnRunner.ts:880–901`). With the flag ON:

- **`dm-ended`.** In the same write that commits the `dm-ended` `CombatEnded` (`combatBootstrap.ts:510–517`), `Room` removes `combatRoom.encounterId` from `resolvedEncounters`. It reads that id before the path deletes `combatRoom`. The encounter objective is not resolved. On later turns `offeredEncounters` offers the key again, so the DM can call `start_combat` with it. The re-started encounter is built fresh from authored data. A DM-ended combat therefore cannot strand a scene.
- **`party-defeated`.** `settle` records it (`combatEngine.ts:150–157, 159–188`), and it cannot be authored. After the TPK choice (`Room.chooseTpkResolution`, `Room.ts:3066–3125`), `retry-checkpoint` restores the pre-combat checkpoint and with it the earlier `resolvedEncounters`. `fail-forward` and `resurrection-or-new-character` keep play in the scene, so with the flag ON they also remove the encounter key from `resolvedEncounters` in the same `commitGameState`. Atlas's decision named only `dm-ended`. I extended it to this case because otherwise a TPK followed by fail-forward would strand a scene whose only live path was that encounter. **Atlas to confirm.**

With the flag OFF, both paths behave as they do today.

**Entry check.** The static rules (unique encounter key per scene, acyclic graph) mean a live encounter key cannot already be in `resolvedEncounters` when a scene is entered. The realistic exception is a legacy session that started encounters before the flag was turned ON. Therefore, at the closing commit for the destination scene, and at room load for the current scene, the server checks every live encounter objective that is still unresolved. If its key is in `resolvedEncounters` while no combat for that encounter is active or ended-pending-evaluation, validation fails. Progression is refused for that session and the server records an operator diagnostic. The session is reported, not silently stranded.

Tests (slices 1–3):
- The validator rejects each shape: a scene with no objectives; an `any` scene with no live objective; an `all` scene with a non-live objective; an encounter objective missing `enemies-fled` as the only path; a liveness encounter key shared across two scenes; a cycle; an `onFailure.nextSceneId` outside `nextSceneIds`.
- A failed check with `onFailure` resolves exactly once to that successor, deferred under held or fallback narration.
- `dm-ended` leaves the objective unresolved, removes the key from `resolvedEncounters`, re-offers the key to `start_combat`, and a re-started rules victory then resolves it.
- TPK followed by `fail-forward` re-offers the key.
- A session whose current scene's live encounter key is already in `resolvedEncounters` at entry or at load is refused with a diagnostic.
- All of the above are unchanged with the flag OFF.

### B1 (High) — the turn seed is persisted before the roll and reused on retry

**Verified gap.** `runTurn` draws a fresh random seed whenever `turnSeed` is absent (`apps/server/src/dm/orchestrator.ts:423–427`). The production runner passes none outside fixture mode (`productionTurnRunner.ts:1223–1232`). Its output-gate `attempt` closure (`:1209`) can run several times within one turn, and each run is a new `runTurn` with a new seed. A Room-level retry of the same action also draws a new seed. `createTurnSeed` accepts a fixed seed only in test mode (`apps/server/src/dm/seed.ts:11–21`). R1's sentence "Its roll must come from the committed RNG seed" therefore named no mechanism, and both kinds of retry re-roll today.

**Decision.**

1. **Persist at acceptance.** When an action is accepted, `Room` draws the seed with `createTurnSeed()`. It persists the seed in a server-only `TurnSeedAssigned { actionId, seed }` event in the same `persist` write as `ActionAccepted`/`RoundActionAccepted`, using `persist`'s `additionalEvents` (`Room.ts:1258–1265`; call sites `:3406`, `:5306`). This happens before any roll. Recovery restores the pending `actionId → seed` map from the committed log and snapshot. The seed is removed from the pending map when that action's turn commits. `TurnSeedAssigned` has no `EVENT_ID_RULES` entry, so it is sent to no one (`eventVisibility.ts:1–5`).
2. **Pass on every retry.** `ProductionSoloTurnRunner` passes the persisted seed as `turnSeed` on every `runTurn` call for that action. That includes every output-gate attempt and every Room-level retry after a failed commit or a restart. `runTurn` gains a production input for a server-persisted seed. This is not the test-only `fixedSeed`: `createTurnSeed`'s test-mode guard stays for `fixedSeed`, and the `LLM_FIXTURE_MODE` override is unchanged.
3. **Independent of tool order.** The per-call RNG is `turnSeed ^ rollIndex` (`orchestrator.ts:749`). `rollIndex` advances with the earlier rolling tool calls in the turn (`:807–809`), and the model may make different calls on a retry. `attempt_objective` therefore ignores `context.seed`. It derives its RNG from `HMAC-SHA256(key = turnSeed as 8 bytes, "lorekeep/adr-042/objective-roll/v1\0" ‖ objectiveId)`, truncated to 64 bits. A given action and objective always produce the same roll.
4. **Server-only.** The seed never goes into a prompt, a wire frame, or telemetry. The DM-stream `TurnStarted` already carries `seed: seedText` (`orchestrator.ts:456–461`). `Room` does not persist it (`Room.ts:6011–6018`), but I did not verify whether the live stream forwards it to clients. Slice 4 must prove that it does not.

Residual: a retry may not repeat the attempt, because the model chooses again. It cannot produce a different roll for that objective. A commit failure is a server fault that a player cannot trigger at will.

Acceptance tests (slice 4; **retry-same-roll**):
- Inject a `writeTurn` failure after a failed `attempt_objective`, then retry the same action. The objective is unspent after the failure, and the retry's dice, total, and outcome are identical.
- Force an output-gate re-attempt (refusal or retry nudge) within one turn. The objective roll is identical across attempts.
- On a retry, the model calls `request_check` before `attempt_objective`, unlike the first try. The objective roll is unchanged.
- Restart between the failed commit and the retry. The seed is recovered and the roll is identical.
- No wire frame, prompt, or telemetry record contains the seed.

### C1 (Med) — the objective roll travels in its own internal carrier

Supersedes R2's "persists one server-only internal roll record" wording and R4's "hands the commit only the internal `ObjectiveRoll`" wording, where those could be read as an event in `result.events`.

- The `attempt_objective` executor writes `ObjectiveRoll { objectiveId, actorId, total, autoFail, dice, rolls, modifier }` into a dedicated internal field of the runner's turn output, `objectiveRolls: ObjectiveRoll[]`. The field is carried from `runTurn` through `ProductionSoloTurnRunner` to `Room`. It is never placed in `result.events`, never persisted as its own event type, and never serialized to a client.
- In both flag modes, `Room` drops every event in a runner's `result.events` whose type is `ObjectiveRoll`, `ObjectiveAttempted`, `ObjectiveResolved`, or `TurnSeedAssigned`. With the flag ON it also drops runner `SceneClosed` (R3 is unchanged on that point).
- `Room` validates the carrier as R4 describes. It then persists its own server-only `ObjectiveAttempted { objectiveId, actorId, total, autoFail, success }`, with `success` computed by `Room` from the authored DC. It also builds the one allowlisted wire `RollEvent` from R2 itself. If the carrier fails validation, nothing is recorded, nothing is spent, and no roll is shown.

Tests (slice 3): a runner `result.events` containing each stripped type is dropped in both modes. An `objectiveRolls` entry never appears in any wire frame or persisted event. A carrier that fails validation produces no visible roll.

### D1 (Med) — the DC bound from total plus outcome is an accepted residual

Supersedes R2's reason for omitting `success` ("together with `total`, it bounds the hidden DC"). The wire roll keeps `total`. The narrated outcome, and a later scene change, together with `total` bound the authored DC. **This is an accepted residual, in the same class as ADR-040's visible-outcome residuals.** It is not mitigated further. Apart from R2's exclusions (`dc`, `dcReason`, `success`, `breakdown.dc`, and any objective-naming field), the attempt roll omits nothing that an ordinary roll display shows. The model-facing summary still states only success or failure. R2's allowlist and tests are otherwise unchanged.

### E1 (Low) — `LateJoinSpawned.sceneId` and the `sceneRef` key

**`LateJoinSpawned` (verified, source read only).** The event carries the authored `sceneId` (`packages/schema/src/events.ts:110–116`). `Room` writes it from `game.sceneId` in the late-join batch (`Room.ts:4494–4499`, write at `:4596–4634`). After that write, the late-join path broadcasts only `StateSync` (`Room.ts:4644–4648`). `LateJoinSpawned` has no `EVENT_ID_RULES` entry, so `projectEventForViewer` returns `null` for it (`eventVisibility.ts:57–62`). Reconnect is StateSync-only, not an event-tail replay (see "Verified current behavior" above). The gateway has no event-log read route. So today the authored id reaches the DM prompt through `summarize.ts` (`:70–76`), which is server-side, but no client. **Implementation requirement:** `LateJoinSpawned` must stay out of every client path. If any later change adds it to the visibility table or to a client projection, that change must strip `sceneId` (preferred) or replace it with the `sceneRef` alias. Slice 6's test that no frame contains an authored scene id covers a late join while the flag is ON and while it is OFF.

**`sceneRef` key.** Supersedes R7's unnamed `serverKey`. The key is `LOREKEEP_SCENE_REF_KEY`, a dedicated server secret of at least 32 random bytes. It is provisioned through the server's secret store and is never shared with any other HMAC use, such as export signing or retry-block cookies. Projection runs whether the flag is ON or OFF, so the key is required once slice 6 ships. Outside test mode the server refuses to start without it. It never falls back to a constant or to the authored id. Tests use a fixed key.

**Rotation.** Replacing the key is a deploy-time action and needs no dual-key window. Every alias changes at once. Each StateSync computes `currentSceneId`, `lastClosed.sceneId`, and `lastClosed.currentSceneId` with the same key, so a single payload is always consistent. Because the client replaces its scene view from each StateSync, it must not infer a scene change from an alias change alone. The generic scene-change message (R6) is driven only by a new `lastClosed.transitionKey`. Test (slice 6): after a key rotation, a reconnect shows no scene-change message, and the aliases within one payload are consistent.

### F1 (Low) — `transitionKey` is a random 128-bit token

Each committed transition's `transitionKey` is 16 bytes from `crypto.randomBytes`, encoded as base64url (22 characters). It is generated at the commit seam and persisted in the `SceneClosed` record and in `lastClosed`. It is not derived from authored scene, objective, or encounter ids, nor from the session, action, turn, or sequence. It is metadata only and never an idempotency input. Test (slice 3): two sessions that make the same authored transition get unrelated keys, and a key never contains or hashes an authored id.

### G1 (Low) — `attempt_objective` rejects every non-actionable id the same way

The tool checks in this order. Each of the first two checks is independent of the id.

1. Active combat → `illegal-transition` (R1).
2. A rolled attempt already happened this turn → `turn-budget-exhausted`. Only an attempt that rolled consumes the turn's budget.
3. Every non-actionable `objectiveId` gets one uniform rejection: `{ ok: false, error: 'illegal-transition', hint: 'That objective is not available.' }`, with no roll, no RNG use, and no state change. This covers an unknown id, an id from another scene, an `encounter` objective, an already-attempted objective, and an already-resolved objective. Error, hint, summary, and side effects are byte-identical across these cases, and the rejection happens before any roll.

This supersedes R1's separate wording for these cases and slice 4's "unknown/foreign/resolved objective rejected". Test (slice 4): the five non-actionable cases produce identical tool results and leave the RNG and state unchanged.

### H1 — line-cite corrections

- R1's `startCombatCalled` cite is `productionTurnRunner.ts:840–848` (was `:838–847`).
- R1's `otherSeatIds` guard is defined at `productionTurnRunner.ts:647–649` and applied at `:936`. The earlier `:945–951` points at the world-mutation executors.
- R2's `executeTool` cite is `orchestrator.ts:378–396`, with the return at `:383–396`.
- R5's `combatOutcome` is `combatEngine.ts:150–157` and `settle` is `:159–188`.
- `runTurn` begins at `orchestrator.ts:423`.

### Needs Chris (update)

- Item 2 (fail-forward) is resolved by L1's `onFailure`.
- Item 1 (adventure #1 objectives) gains one constraint: each encounter-free scene needs a check objective with an authored `onFailure` successor, and every encounter objective used as a scene's path out must list both `party-victory` and `enemies-fled`.

### Verification record

Source read in the branch worktree at 4170794:
- `apps/server/src/dm/seed.ts`; `apps/server/src/dm/orchestrator.ts:376–396, 423–461, 740–809, 868–878, 1030–1040`
- `apps/server/src/room/productionTurnRunner.ts:372–392, 645–651, 740–770, 836–848, 878–905, 936, 1205–1240`
- `apps/server/src/room/Room.ts:1258–1265, 3040–3125, 3402–3409, 4480–4648, 5990–6025`
- `apps/server/src/room/eventVisibility.ts:1–80`, `apps/server/src/room/combatEngine.ts:150–188`, `apps/server/src/room/combatBootstrap.ts:505–518`, `apps/server/src/room/death.ts:75–86`
- `apps/server/src/dm/encounters.ts:88–105`, `apps/server/src/dm/summarize.ts:60–80, 730–745`
- `packages/schema/src/events.ts:22–47, 100–117`; `packages/engine/src/tools/check.ts:108–115`; `packages/engine/src/combat/checks.ts:38–44`; `packages/engine/src/adventure/validate.ts:120–156`; `packages/engine/adventures/01/adventure.json` (scene graph and encounter keys)
- grep of `apps/server/src` for `createHmac` and for event-log read routes

Not verified: whether the live DM stream forwards `TurnStarted.seed` to clients (B1 item 4 makes that a test). Repowise was not used. This is a documentation-only change, and no tests were run.
