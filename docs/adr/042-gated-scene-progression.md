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

## Addendum — atomic-commit feasibility precondition (2026-11-01)

**Open precondition; unverified.** The design above requires one durable atomic outcome spanning turn resolution, narration persistence, scene transition/state, and the durable player-visible update. Whether the existing persistence architecture can provide that boundary has **not** been verified. Do not treat the proposed single transaction as an established capability or begin implementation on that assumption.

Before any implementation card for ADR-042 (including card `5fd8ad52`) is started, inspect the live code and persistence paths and document the actual transaction boundaries and commit ordering for each of:

1. Turn resolution and `TurnResolved` persistence.
2. Narration persistence, including `NarrationCompleted` and the approved/held-output path.
3. Scene transition, `SceneClosed`, and resulting scene/completion state.
4. The player-visible update: its durable record/queueing boundary and its post-commit broadcast/delivery path.

Record whether these writes share one database transaction, which state is persisted versus in-memory, and where a crash or send failure can leave a partial outcome. In particular, distinguish atomically recording a player-visible update from delivering a network broadcast: delivery itself must not be claimed to participate in a database transaction unless the code and transport actually establish that guarantee.

If inspection proves one transaction can cover the required durable writes, update the implementation plan to name that transaction and its boundary. If it cannot, stop before implementation and resolve a follow-up design specifying a safe fallback, such as ordered durable writes with transition-key-based idempotent recovery, or a transactional outbox for the visible update. The fallback must preserve recoverable ordering, prevent duplicate transitions/notifications, and define restart behavior; do not weaken the invariant or substitute process-local state. The resulting design decision and revised acceptance/fault-injection cases must be recorded before implementation proceeds.

This feasibility check is a blocking prerequisite for **all** ADR-042 implementation cards, including schema/persistence, proposal/gating, transition, recovery, and player-update work. Mark the precondition complete only after source inspection has been recorded and the single-transaction design or fallback has been explicitly selected. Until then, ADR-042 remains a design proposal and atomicity remains unverified. This gate does not alter the feature-flag rule: `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION` remains OFF by default and is enabled only by the exact string `true`, following ADR-038.

## Revision — Bastion design review (2026-11-01)

This revision is append-only. It clarifies/corrects the preceding proposal where it described existing behavior or a selected persistence design; all implementation cards remain **blocked** until the design and replay open item below are resolved. The feature-flag rule above remains unchanged: default OFF, enabled only by the exact string `true`.

### Corrections to current-code description

The earlier statement that a scene summary is derived from an accepted committed transition does not describe current code. `ProductionSoloTurnRunner` calls `closeScene` while processing the generated result (`apps/server/src/room/productionTurnRunner.ts`); this persists the summary through `RegistryMemory.closeScene` in its own `BEGIN`/`COMMIT` transaction (`apps/server/src/dm/memory.ts`). The room's `writeTurn` transaction occurs later (`apps/server/src/room/Room.ts`). Thus a summary can persist even if the subsequent turn commit fails. The revised design requires summary generation/persistence only after the transition and turn have committed, or as a retryable derived step keyed by the committed transition key. Add a fault-injection case where summary persistence succeeds and turn commit fails; the new design must make that ordering impossible, and prove retries do not create an orphan summary or duplicate one.

There is also an existing gap in canonical close semantics. The runner only rewrites a close into a transition when `adventure?.ok && closed.sceneId === initialSceneId` (`productionTurnRunner.ts`, around the `nextSceneAfterClose` call); `nextSceneAfterClose` returns `undefined` for an unknown scene or invalid successor (`packages/engine/src/adventure/transition.ts`), and that case is not raised as an error by the runner. `sceneCloseTool.ts` rejects a missing adventure and an invalid requested successor, but does not enforce source-scene equality. Consequently `SceneClosed` can still be committed without a valid scene transition. This is existing behavior, not the intended contract: the authoritative commit gate must reject missing adventure, source mismatch, unknown source, and invalid successor, and must never commit a `SceneClosed` without its corresponding valid transition/completion.

The existing `storyCombatFlagEnabled` parser correctly checks exact equality with `'true'` (`productionTurnRunner.ts`); this is the ADR-038 flag, not yet the ADR-042 rollout flag. However, the existing leave-judge `close_scene` path is unconditional and remains available independently of that flag. Therefore acceptance test 1's “no legacy ungated route” condition currently fails. The new ADR-042 flag must be checked again at authoritative commit time, not merely when exposing a proposal affordance, and no leave-judge/legacy path may bypass that gate.

### Selected transaction and delivery design

The preceding addendum's atomicity feasibility precondition is now resolved for durable turn state: `Persistence.writeTurn` is one transaction (`apps/server/src/persistence/index.ts`) that locks the session row `FOR UPDATE`, checks the lease fence, and atomically appends events and persists the resulting state/snapshot (and its supported narration/registry data). The room invokes it from the serialized turn commit path (`Room.ts`); it already carries the turn events, state/snapshot, and narration event. The selected design is to compute/validate the progression proposal inside that serialized authoritative commit path, include `SceneClosed` and resulting scene/completion state in the same `writeTurn` transaction, then generate/persist the scene summary after commit with the transition key as its idempotency key.

Network broadcast is not transactional: `Room.ts` broadcasts only after `writeTurn` returns. A durable event is therefore not by itself proof that each connected player received the visible update. The selected design requires a durable, sequence-numbered, replayable record for the player-visible scene-change update in the committed write, followed by post-commit broadcast. The update must be recoverable and delivered without duplicating the logical update.

**Reconnect replay remains UNVERIFIED.** The inspected room recovery path reconstructs state from the snapshot and event tail (`apps/server/src/room/recovery.ts`), and the inspected reconnect narration-history path sends narration history; this inspection did not establish that a new player-visible scene-change record is replayed to reconnecting seats. Do not mark the prior replay acceptance test as satisfied. Prove reconnect replay and authorization/deduplication behavior in implementation research before unblocking any ADR-042 implementation card; if the existing protocol cannot replay the durable update, document and select the needed protocol/outbox design first.

### Proposal authorization and party-turn resolution

A progression proposal is carried only by the account/seat that owns the originating accepted action; it is not a party-wide authorization inferred from narration. For a multi-seat party turn, resolve the party turn under the existing room serialization and evaluate at most the proposal attached to the authoritative action/turn being committed; proposals from other seats or actions are not merged or allowed to override its source/target. Add a negative test that a different seat cannot attach or replay a proposal under another seat's action/transition key, and assert no `SceneClosed`, summary, state change, or player update results.

### Required acceptance/fault cases and blocked status

In addition to the existing cases, require: (a) summary-persisted/turn-commit-failed ordering fault; (b) unknown/mismatched source, missing adventure, or invalid successor cannot commit `SceneClosed`; (c) exact-true flag still rejects the legacy leave-judge route unless it passes the same commit gate, and flag-off rejects at commit even if a proposal was exposed earlier; (d) the cross-seat authorization negative case above; and (e) a durable player-update record survives process restart and is replayed to a reconnecting eligible seat exactly once logically. Until reconnect replay is verified and the durable update mechanism is specified against the actual protocol, all ADR-042 implementation cards remain blocked. This revision selects the existing `writeTurn` transaction for committed transition/state/narration data plus post-commit retryable summary; it does not claim network delivery is atomic.

### Verification record for this revision

Rechecked the cited runner, scene-close tool, transition helper, summary persistence, room turn commit/broadcast, persistence transaction, and room recovery paths in the PR worktree. `writeTurn` has session-row locking and lease fencing; the summary write is a separate transaction before room turn commit; broadcast occurs after commit. Reconnect replay of a scene-change update is **unverified** and remains a blocking item. No implementation code was changed.

## Addendum — reconnect scene projection and replay (2026-11-01)

This addendum resolves the preceding **Reconnect replay remains UNVERIFIED** blocker with a verified current-code baseline and a selected, additive protocol design. It does not change the proposal, transaction, or rollout decisions above. All implementation remains blocked behind `LOREKEEP_ADR_042_GATED_SCENE_PROGRESSION`, default OFF and enabled only by the exact string `true`.

### Verified current behavior

A reconnect is not an event-tail replay. `apps/server/src/gateway/ws.ts` passes `lastSeq = -1` and `requireExistingSeat: true` on join (lines 1111–1118); `Room.subscribe` sends `StateSync` when its sequence differs, followed by narration history, combat snapshot, seat-private round sync, and the reconnecting account's open clarification frames (`apps/server/src/room/Room.ts:1659–1680`). `clientSyncPayload` contains filtered `state`, bound seat IDs, and round data, but no scene id or closed-scene marker (`Room.ts:2012–2040`). Narration history carries turns with `turnId`, text, tier, and optional action text, is capped at 24,000 characters and hidden-entity scrubbed, and has neither scene identity nor `SceneClosed` (`Room.ts:1709–1759`).

The web client currently has no scene reducer: non-test `apps/web/src` contains no `sceneId` or `SceneClosed` handling. Thus a reconnecting seat today gets current room state and narration but cannot identify the current scene or learn that a scene closed while disconnected; old-scene narration may still appear in history. This is an actual replay gap, not merely an unverified assumption. There is no current scene-change reducer to double-apply, but any future reducer needs explicit idempotency semantics.

Two related assumptions are false in current code:

1. Summary persistence is a separate, earlier transaction than the room's `writeTurn`: `ProductionSoloTurnRunner` calls `closeScene` while processing the result (around `productionTurnRunner.ts:1487`), and `RegistryMemory.closeScene` begins its own transaction (`dm/memory.ts:395–398`); room turn persistence occurs later through `Room.writeTurn` (`Room.ts:1573–1584`). A summary can therefore survive a failed turn commit. The selected ADR design remains: commit the transition first, then produce/store its summary as a retryable, transition-key-idempotent derived step.
2. A committed `SceneClosed` does not prove a valid transition. The runner rewrites the event only if `nextSceneAfterClose` returns a transition (`productionTurnRunner.ts:1466–1485`), while `nextSceneAfterClose` can return `undefined` for an unknown scene or invalid successor (`packages/engine/src/adventure/transition.ts:8–17`). The unrewritten close can remain in the event result. The authoritative commit must reject it; implementation must never persist a canonical `SceneClosed` without a valid successor or completion.

### Selected additive wire contract

When the ADR-042 flag is ON, extend the existing `StateSync.payload` with an optional, versioned `sceneProgression` projection. When OFF, omit it and preserve existing wire behavior. The projection is built from the committed/recovered authoritative head, not runner-local state or narration:

- `currentSceneId`: exact id of the currently committed active scene; null only when the adventure is complete or no scene is active.
- `lastClosed`: null until a valid close has committed; otherwise `{ sceneId, transitionKey, seq, currentSceneId, completed }` for the latest committed close. `seq` is the durable close event sequence; `transitionKey` is the stable idempotency identity already required by this ADR.

This is a snapshot, not a command or a request to re-run a transition. On a close, the same projection may also be sent live after commit. The `StateSync` snapshot is authoritative and replaces the client's scene-progression view; `lastClosed` is informational and must not mutate `currentSceneId`. A client may remember/acknowledge a marker only by its stable `(session, transitionKey)` identity. Re-delivery of the same marker or snapshot leaves the projected state unchanged; a later close replaces `lastClosed`. No reducer increments, advances, or toggles scene state from replayed markers, so replay cannot double-apply.

Projection safety is an allowlist: expose only the active/closed scene identifiers, transition key, committed event sequence, and completion bit. Do not serialize scene titles, summaries, successor lists, hidden authoring fields, model text/reasoning, registry/memory data, or any private seat data. Continue to apply the existing viewer-specific state projection and hidden-content policy. Do not reuse narration history to carry progression metadata. A reconnecting authorized seat receives only its own projection from the committed head. The live update is post-commit; failed/rejected transitions emit neither a marker nor an advanced current-scene projection.

The durable `SceneClosed` event plus recovered snapshot remains the source of truth for `currentSceneId` and the latest marker; do not add a second mutable scene pointer or rely on process memory. Retain enough event identity/sequence in recovery to reconstruct `lastClosed` after restart, including the case where a client missed the live send. If the current recovered snapshot/event-tail shape cannot reconstruct these fields, persist the minimal projection inputs in the same `writeTurn` transaction. Network delivery remains non-transactional: after a restart, reconnect `StateSync` reprojects the committed result, while the transition key makes repeated delivery logically idempotent.

### Minimal implementation cards, tests first

Every card below is **blocked until its acceptance tests are written and pass in fixtures with the flag OFF and ON**. The sequence is intentional; do not expose a partial implementation or enable the flag during development rollout.

1. **Protocol and projection contract.** First add schema/server tests proving flag-OFF payloads are unchanged, flag-ON `StateSync` includes current active scene and latest close marker, viewer projection excludes all non-allowlisted/hidden data, and marker delivery does not mutate snapshot state. Then implement the optional payload type and authoritative projection from recovered committed state.
2. **Canonical close validation and durable marker.** First add runner/transaction tests proving unknown or mismatched source, missing adventure, invalid successor, summary-persisted/turn-commit-failed ordering, and stale/duplicate retries cannot create an orphan or invalid `SceneClosed`; prove valid transition/completion, state, and marker commit together in one `writeTurn`. Then route every close path through the flagged authoritative validation and persist/recover the stable transition identity and sequence. Keep summary generation/storage after commit and idempotent by transition key.
3. **Reconnect reducer and live delivery.** First add client tests for snapshot replacement, out-of-order/duplicate marker replay, duplicate live delivery, completion, restart/reconnect, and legacy payloads; assert one logical close and no second scene advance. Then consume `sceneProgression` as snapshot state and marker metadata, and send the projected live update only after commit. Confirm every reconnect receives the same projection even if the live message was missed.
4. **Flag and end-to-end recovery gate.** First add an integration test that turns the flag OFF after a proposal was formed and proves commit is rejected without close, summary, state advance, or marker; also test OFF reconnect compatibility and ON restart/reconnect replay for eligible seats. Then wire the exact-`true` ADR-042 flag at both affordance and authoritative commit boundaries. Keep default OFF; no rollout or enablement is part of these cards.

These are the minimum slices: protocol projection, canonical durable close, consumer/live replay, and flag/recovery integration. No implementation card may start before its own tests-first contract is present, and the feature remains blocked behind the OFF-by-default flag until the full acceptance set passes. This addendum does not authorize enabling the flag, changing unrelated event replay, or changing narration-history semantics.

### Verification record

Verified against the `sage/adr-042-replay-addendum` worktree at `origin/main` 912549c: `apps/server/src/gateway/ws.ts:1111–1118`; `apps/server/src/room/Room.ts:1659–1680, 1709–1759, 2012–2040, 1573–1584`; `apps/server/src/room/productionTurnRunner.ts:1466–1495`; `apps/server/src/dm/memory.ts:395–415`; `packages/engine/src/adventure/transition.ts:8–17`; and non-test search of `apps/web/src` for `sceneId`/`SceneClosed` (no matches). Documentation only; no tests run.

### Correction — keep the canonical close sequence off the wire (2026-11-01)

This correction supersedes the preceding reconnect addendum's `lastClosed.seq` field and its description of the committed event sequence as part of the StateSync projection. The canonical event sequence remains authoritative for persistence, replay, recovery, and internal references, but it is never included in `sceneProgression` or any other wire projection. In particular, `lastClosed` is exactly `{ sceneId, transitionKey, currentSceneId, completed }`; its stable `(session, transitionKey)` identity is sufficient for logical deduplication and acknowledgement. Do not expose a canonical sequence directly or through a renamed field, derived offset, or event-order value.

`StateSync` remains an ADR-040 class-(b) current-cursor reply. Its outer wire envelope carries only the recipient's current viewer-local cursor, attached by the per-seat transmit layer; that cursor does not advance for StateSync and is not the close event's sequence. The optional ADR-042 `sceneProgression` payload contains no cursor of its own. Build it from committed/recovered authoritative state and reconstruct the latest marker internally from the durable event/snapshot data. If recovery needs the canonical close sequence, retain it only in internal persistence/recovery structures and remove it before serialization. Do not add canonical `seq`, `eventSeq`, global head, or another sequence-valued proxy to the payload. This keeps the durable SceneClosed event as the source of truth while complying with ADR-040's viewer-local-only wire contract.

The allowlist is therefore limited to `currentSceneId` and, when present, `lastClosed.sceneId`, `lastClosed.transitionKey`, `lastClosed.currentSceneId`, and `lastClosed.completed`. The existing default-OFF, exact-string-`true` flag rule and all previously stated blocked-implementation gates remain unchanged. Before any implementation card is unblocked, its protocol/recovery acceptance cases must verify that canonical event sequences remain internal, StateSync carries only its viewer-local current cursor, and repeated snapshots/live markers deduplicate by transition key without using sequence ordering.
