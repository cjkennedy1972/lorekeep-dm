# ADR-038: Story-to-combat transition

Status: Accepted (2026-10-27) · Date: 2026-10-27 · Owner: Sage · Depends on: ADR-004, ADR-007, ADR-018, ADR-022, ADR-033, ADR-034

Append-only: this ADR adds a constrained transition from an authored scene encounter to the existing combat executor. It does not edit earlier ADRs or change combat-turn narration rules.

## Context

Exploration prompts currently omit `start_combat` (ADR-022 §2.3; `apps/server/src/dm/prompt.ts`). No deterministic server path promotes a scene's declared encounter. Adventure 01 has `scene.encounterIds` referencing `encounters[].id`, whose roster uses `monsterIds` such as `monster:goblin-warrior`; the existing DM tool instead accepts freeform `enemies[{monsterId,count,spawnRef?}]` in the `srd:monster/...` catalog namespace. Thus prose can narrate hostility without engine combat, while simply exposing the old tool invites guessed roster data. The engine already owns combat initialization, map placement, and initiative. ADR-033 requires one narration per resolved turn; combat-start narration is the opening, not an additional narration after a resolved combat turn.

## Decision

Offer the model a constrained `start_combat` affordance during exploration only when the current scene declares one or more encounters. The model supplies only an authored encounter key. It cannot choose ambush side, initiative modifiers, monster IDs/counts, positions, or map details. The server resolves the key from adventure data, validates scene membership and use status, then invokes the existing start-combat executor using the authoritative roster and spawn/map data. No lexical inference or server guess from narration/player prose starts combat.

A call is valid only in a turn whose accepted player action the model judges hostile, or when the encounter's authored data declares a scene-entry trigger. The server does not judge player intent. Ambush side and initiative modifiers come only from encounter-authored data (default: none). The model must not supply `ambushSide`. Residual prompt-injection risk: player text can induce the model to start an encounter offered in the current scene. The transition remains constrained to that authored encounter; no lexical classifier attempts to distinguish player instructions from hostile intent. The prompt includes each eligible encounter's key and a one-line hook derived from authored scene data; it excludes entity UUIDs and secrets. Hostile action/combat narration must be preceded by a successful call. If the model narrates combat without one, preserve narration behavior but emit an observability event; do not infer combat state.

Roster and combat parameters are authoritative authored data. The model cannot alter monster IDs or counts. Solo scaling applies only when adventure data declares it; otherwise use the authored roster as-is. For scenes with multiple encounters, the model may select any unresolved encounter key declared on the current scene, one per call.

An encounter becomes `resolved` whenever the engine ends its combat, regardless of victory, flee, or defeat. It cannot be started again unless its authored data has `repeatable: true` (none do in Adventure 01). Starting an already-active or resolved encounter is rejected with closed code `ENCOUNTER_ALREADY_USED`. State is per session. XP and loot are awarded only through existing resolution paths, never at combat start. A successful start commits atomically with the turn (event-before-narration per ADR-022). If the output gate holds the opening narration, show the standard holding notice and an engine-generated mechanical opening summary (combatants, initiative order, and positions from server data, with no model text); combat remains live because rollback would desynchronize persisted engine events. Generate that summary per viewer by applying `projectCombatForViewer` in `apps/server/src/room/combat.ts` to authoritative `combatRoom` state; never generate it from raw engine state. A hidden entity is absent from both the summary and `CombatStarted` for every seat that does not control it. Project `CombatStarted.order` per viewer using ADR-034 §3/event visibility, while retaining the full order in the persisted event for replay/internal use. ADR-018/ADR-033/ADR-034 define no host-privileged visibility bypass, so the host receives only its ordinary per-viewer projection; do not expose hidden entities through a host view.

## Data contract and validation

1. `start_combat` requires `encounterId: string`, exactly an adventure `encounters[].id` (e.g. `encounter-e2-lookouts`). Remove model-supplied `enemies`, `monsterId`, `count`, `spawnRef`, and `ambushSide`; construct executor input server-side.
2. Scene ownership uses `scenes[].encounterIds`; encounter data uses `encounters[].id`, `monsterIds`, `mapId`, `partySpawnMarkerId`, and `enemySpawnMarkerId`. Preserve these authored field names. Resolve roster/count semantics through the adventure/catalog adapter; never interpret a scene key as a monster ID.
3. Map adventure IDs (`monster:<slug>`) to canonical engine catalog IDs (`srd:monster/<slug>`) through a build-time validated table in the adventure data loader. Validate every encounter roster against the catalog at load; a missing mapping fails adventure load, not a live turn. This validation and its test are implementation scope. Do not string-rewrite unknown values or silently fall back.
4. Validate current `sceneId`, scene membership, encounter existence, trigger eligibility, and per-session active/resolved state. Serialize validation and executor invocation with the Room's authoritative command path. Rejections do not mutate game state. Closed errors include `encounter-not-in-scene`, `unknown-encounter`, `ENCOUNTER_ALREADY_USED`, and `encounter-roster-invalid`; existing engine errors still apply after resolution.
5. Allow at most one `start_combat` call per turn; a second is rejected and counts toward `MAX_TOOL_CALLS`. Allow at most one successful start per encounter per session. Rejected calls are logged and counted per session. Repeated rejected start calls count against the ADR-029 §8 **Action-input budget — Mutations** counter (6 per 60 s per seat); once a session exceeds that counter, withdraw the model’s `start_combat` affordance for the rest of that scene. `CombatStartRejected` records the rejected encounter ID only if it matches `^[a-z0-9:_-]{1,64}$`; otherwise record a hash. Never record player text.
6. A rejected start returns a closed error to the model, which must continue in prose without combat. The player sees no technical error details.

## Moderation and observability

Record structured events for `CombatStartToolOffered`, `CombatStartToolCalled`, `CombatStartRejected`, and `CombatNarratedWithoutStart`. Include `activeMode`, `sceneId`, `encounterId` when known, and rejection code where applicable. Record offered tool names and redacted arguments (for this tool, key only; never prompt text, UUIDs, roster secrets, or raw model reasoning). Apply existing retention/access controls; telemetry is diagnostic, not an alternate state transition. The narrated-without-start event is derived from turn/tool outcome, not a lexical content classifier.

## Rollout, acceptance criteria, and verification

Ship schema, prompt, validation, and telemetry together behind a server feature flag defaulting OFF. Enable in development, verify content mapping and event traces, then canary a small set of sessions; monitor start success/rejection rates and narrated-without-start events before default-on. Roll back by disabling the affordance; existing combat remains unchanged.

The implementation PR is accepted only when it demonstrates all of the following:

- Route/unit coverage for valid current-scene keys (authoritative roster/map), invalid and cross-scene keys, already-active/resolved keys, hostile-action and authored scene-entry eligibility, and no tool when no encounter is declared.
- Atomic duplicate-call handling; one call per turn, MAX_TOOL_CALLS accounting, per-session rejection counts/logging and redaction; rejection leaves state unchanged and returns a closed model error with no technical player-facing error.
- Authored repeatable/resolved behavior across victory, flee, and defeat; XP/loot only through existing resolution; no model-supplied roster, counts, ambush, or initiative overrides; authored solo scaling only.
- Build-time monster-ID mapping and roster/catalog validation, including a test proving a missing mapping fails adventure load.
- Moderation-gated opening behavior: held narration shows the standard notice plus a per-viewer summary generated through `projectCombatForViewer`, with combat still live; a hidden monster appears in neither summary nor `CombatStarted` for a non-controlling seat. Cover the opening-summary generator with the same visibility test fixtures as `combatRoom`.
- `CombatStarted.order` is viewer-projected with hidden entities omitted for non-controlling seats; full order remains persisted for replay/internal use, and no host-privileged bypass is defined. Repeated rejected starts consume ADR-029 §8 Action-input budget — Mutations (6 per 60 s per seat); exceeding it withdraws `start_combat` for the rest of that scene.
- Live smoke: on Adventure 01, a simulated player reaches the map within five provoke attempts; confirm map/initiative/combat state comes from the executor, opening narration is not duplicated, and logs contain no player text or secrets.

## Amendment note (2026-10-27)

This decision also amends ADR-034 §5’s `CombatStarted.order` visibility row: order is per-viewer projected as specified above. ADR-034 itself remains unchanged (append-only).

## Alternatives

- Keep the existing freeform roster tool in exploration: rejected because it invites hallucinated IDs/counts and bypasses authored encounter constraints.
- Deterministic lexical or prose trigger: rejected because it is ambiguous, spoofable by quoted/player text, and cannot establish encounter intent safely.

## Verification record

Docs-only decision. Source inspection: ADR-022 §2.3, ADR-007, ADR-018; Adventure 01 `scenes[].encounterIds` and `encounters[]`; investigation `combat-start-investigation.md`. Prettier check and PR status are recorded with the implementation review; live behavior is not verified by this ADR.

## Correction — 2026-10-27

Correction: Decision item 7 (explicit monster-id mapping table validated at adventure load) is superseded. Authored adventure ids are already in the catalog namespace (monster:goblin-warrior) and the engine adventure validator (packages/engine/src/adventure/validate.ts) already rejects dangling encounter monsters at load; the engine start_combat input uses srd:monster/<slug> and converts back (tools/combat.ts). The server therefore converts with a prefix rule (toEngineMonsterId) and needs no table.

## Status update (2026-10-27)

Accepted 2026-10-27, on Atlas's decision as delegated by Chris. The decision text above is unchanged. This note records what `origin/main` ships against the contract (implementation in #364, squash-merged as `ce40cf7`; its tree equals the final PR head `f5b08c9d`), the deviations that were accepted, and the residuals that remain.

Deviations and residuals:

1. **Rejection budget is not the ADR-029 §8 Mutations bucket.** Decision item 5 counts repeated rejected starts against the shared Mutations counter. The shipped budget is a separate in-process budget, `EncounterStartRejectionBudget` in `apps/server/src/dm/encounters.ts`, scoped by (session, scene), with two structures. Counters are bounded and evictable. Withdrawals are kept in a separate capped Map: the oldest entry is evicted only on overflow, and the Map is cleared on scene change and by `clearSession`. Because the budget is in process memory, it resets on process restart. Moving it onto the shared bucket is follow-up card `e7722e8c`.
2. **`startTrigger` is not enforced server-side.** The server does not judge whether a player action is hostile. Offers are limited to unresolved encounters of the current scene. Prompt injection can therefore induce the model to start an authored encounter offered in the current scene. This is an accepted residual. The transition stays constrained to that authored encounter.
3. **Model-facing `start_combat` takes `encounterId` only.** The freeform roster (`enemies`, `monsterId`, `count`, `spawnRef`, `ambushSide`) is removed from the model schema. The engine keeps its roster schema internal to the server. `start_combat` is not offered in combat mode, and it is not offered at all unless `LOREKEEP_ADR_038_STORY_COMBAT` is set to `true`. The flag defaults to off.
4. **Spawn markers.** `spawnRef` flows from the authored `enemySpawnMarkerId` to the engine (`apps/server/src/dm/encounters.ts`). Party placement ignores `partySpawnMarkerId` today: production placement takes the first free cell of the party spawn zone (`apps/server/src/room/combatBootstrap.ts`). Tracked on card `18632c96`.
5. **Live evidence is scripted.** The smoke run seeded the scene in the database and restarted the API, because the live model rarely calls `close_scene` (card `5fd8ad52`). It therefore does not exercise scene progression by the model. Across the two runs, the model called `start_combat` in 2 of about 10 provocation attempts (card `ef7c2830`). The summary and checksum are in `docs/plan/evidence/adr-038-scripted-smoke.md`. The full report is outside the repository.
6. **The smoke ran at `b3d63dce`, a pre-final PR head.** Later commits changed the rejection-budget withdrawal handling: `572e4e6` (retain withdrawn encounter scenes) and `f5b08c9d` (separate encounter withdrawals from counters). Those changes landed after the smoke, are on `main`, and are covered by unit and DB tests. They were not part of the live smoke. To see the difference, run `git diff b3d63dce f5b08c9d`.
