# ADR-038: Story-to-combat transition

Status: Proposed · Date: 2026-10-27 · Owner: Sage · Depends on: ADR-004, ADR-007, ADR-018, ADR-022, ADR-033, ADR-034

Append-only: this ADR adds a constrained transition from an authored scene encounter to the existing combat executor. It does not edit earlier ADRs or change combat-turn narration rules.

## Context

Exploration prompts currently omit `start_combat` (ADR-022 §2.3; `apps/server/src/dm/prompt.ts`). No deterministic server path promotes a scene's declared encounter. Adventure 01 has `scene.encounterIds` referencing `encounters[].id`, whose roster uses `monsterIds` such as `monster:goblin-warrior`; the existing DM tool instead accepts freeform `enemies[{monsterId,count,spawnRef?}]` in the `srd:monster/...` catalog namespace. Thus prose can narrate hostility without engine combat, while simply exposing the old tool invites guessed roster data. The engine already owns combat initialization, map placement, and initiative. ADR-033 requires one narration per resolved turn; combat-start narration is the opening, not an additional narration after a resolved combat turn.

## Decision

Offer the model a constrained `start_combat` affordance during exploration only when the current scene declares one or more encounters. The model selects an encounter by its authored key; it does not author enemies, counts, IDs, positions, or map details. The server resolves that key from adventure data, validates scene membership and unresolved status, then invokes the existing start-combat executor using the authoritative roster and spawn/map data. No lexical inference or server guess from narration/player prose starts combat.

The prompt includes each declared encounter's key and a one-line hook derived from authored scene data; it excludes entity UUIDs and secrets. It explicitly says hostile action/combat narration must be preceded by a successful `start_combat` call. If the model narrates combat without a call, preserve that narration behavior but emit an observability event; do not infer combat state.

On success, the existing combat bootstrap publishes map/combat state. The same turn's narration describes the opening. Subsequent resolved combat turns retain the single-narration rule (ADR-033).

## Data contract and validation

1. Change the `start_combat` tool schema to require `encounterId: string` (the exact field name and value space of adventure `encounters[].id`, e.g. `encounter-e2-lookouts`). Remove model-supplied `enemies`, `monsterId`, `count`, `spawnRef`, and `ambushSide` from this transition tool. Existing executor input is constructed server-side.
2. Scene ownership is expressed by `scenes[].encounterIds`; catalog data is `encounters[].id`, `monsterIds`, `mapId`, `partySpawnMarkerId`, and `enemySpawnMarkerId`. Preserve these authored field names. Resolve every `monsterIds` entry and its roster/count semantics via the adventure/catalog adapter; do not reinterpret a scene key as a monster ID.
3. Reconcile namespaces in that adapter: map adventure IDs (`monster:<slug>`) to canonical engine catalog IDs (`srd:monster/<slug>`) through an explicit, validated mapping. Do not string-rewrite unknown values or silently fall back. Missing/ambiguous mapping rejects with `encounter-roster-invalid`; content validation should catch it before play.
4. Validate the current `sceneId`, that `encounterId` is listed in its `encounterIds`, that it resolves in the active adventure, and that it has not already been resolved in this session. Rejections do not mutate game state. Closed rejection codes: `encounter-not-in-scene`, `unknown-encounter`, `encounter-already-resolved`, `encounter-roster-invalid`; existing engine errors still apply after resolution. Serialize validation and executor invocation with the Room's authoritative command path to prevent duplicate starts.
5. Mark an encounter resolved only after the executor succeeds, durably with session state/replay semantics. Retry/idempotency must return the original successful result rather than create duplicate combatants.

## Prompt, moderation, and observability

The exploration prompt offers the tool only for declared unresolved encounters and includes `{encounterId, hook}` for each; hooks are authored, concise, and contain no UUIDs or hidden/private facts. Player text remains quoted untrusted input under ADR-007. No new free-text field or authority path is introduced: an encounter key is a lookup into server-owned data, not permission to start arbitrary combat. Existing output moderation still applies to narration; hostile action never bypasses server validation.

Record structured events for `CombatStartToolOffered`, `CombatStartToolCalled`, `CombatStartRejected`, and `CombatNarratedWithoutStart`. Include `activeMode`, `sceneId`, `encounterId` when known, and rejection code where applicable. Record offered tool names and redacted arguments (for this tool, key only; never prompt text, UUIDs, roster secrets, or raw model reasoning). Apply existing retention/access controls; telemetry is diagnostic, not an alternate state transition. The narrated-without-start event is derived from turn/tool outcome, not a lexical content classifier.

## Rollout and verification

Ship schema, prompt, validation, and telemetry together behind a server feature flag defaulting OFF. Enable in development, verify content mapping and event traces, then canary a small set of sessions; monitor start success/rejection rates and narrated-without-start events before default-on. Roll back by disabling the affordance; existing combat remains unchanged.

Required automated route/unit coverage uses a stub model that calls `start_combat` with: a valid current-scene key (combat starts, authoritative roster/map used); an invalid key; a valid key already resolved; and a key declared only by another scene. Also verify tool absence when no encounter is declared, atomic duplicate-call behavior, namespace mapping failures, and that narration without a call emits observability but starts no combat.

Live smoke checklist: enter a scene with a declared encounter; confirm offered schema/context contains only key and hook; trigger a hostile opening; confirm map/initiative/combat panel appears from executor state; confirm one opening narration and no duplicate combat; attempt a cross-scene/used key and confirm rejection/no state change; narrate hostility without a tool call and confirm no combat plus diagnostic event; inspect logs for redaction.

## Alternatives and open questions

- Keep the existing freeform roster tool in exploration: rejected because it invites hallucinated IDs/counts and bypasses authored encounter constraints.
- Deterministic lexical or prose trigger: rejected because it is ambiguous, spoofable by quoted/player text, and cannot establish encounter intent safely.
- Open questions: should an encounter be marked resolved permanently or become available again after `end_combat`/retreat? What is the canonical adapter for adventure `monster:` IDs to SRD catalog IDs, and can future encounter data express counts explicitly? Which authored field supplies the one-line hook without revealing hidden facts?

## Verification record

Docs-only decision. Source inspection: ADR-022 §2.3, ADR-007, ADR-018; adventure 01 `scenes[].encounterIds` and `encounters[]`; investigation `combat-start-investigation.md`. Prettier check and PR status are recorded with the implementation review; live behavior is not verified by this ADR.
