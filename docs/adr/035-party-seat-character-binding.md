# ADR-035: Party-seat character binding and late-join PC entry

Status: Proposed · Date: 2026-10-23 · Owner: Sage · Scope: M4 party seat identity, character ownership, and late-join PC entry

Append-only: this ADR adds a decision; it does not amend existing ADR bodies. It is authoritative for the party binding gaps identified by M4-4 PR #278. It complements ADR-029 through ADR-034.

## Context

Spec §3.2 US-P3 says each seat has exactly one active PC, and §3.2 US-P5 admits a player at a safe point. Spec §4.2 models `Seat {accountId,...,pcId?}`, but no implemented party binding exists: `sessions.character_id` and `sessions.character` are the solo-session binding. SeatJoined carries account identity, not a durable selected PC. Combat events and initiative refer to engine `entityId`/`activeEntityId`, not accounts or seats. Therefore round submission identity (ADR-029), initiative/turn ownership and reactions (ADR-033/034), rest voting (ADR-030), and defensive autopilot (ADR-031) cannot reliably resolve a party PC. Late-join approval alone does not make the entrant combat-ready.

## Decision

### 1. Ownership model and binding authority

Add `session_seat_characters` (name provisional; schema implementation may use `seat_characters`) as the durable binding and snapshot record: `session_id`, stable `seat_id`, `account_id`, `character_id`, `character_revision`, `character_snapshot` (validated canonical character state), `bound_at`, `unbound_at`, and `binding_status` (`active|released|redacted`). Keep party binding out of `sessions.character_id`; that field remains solo-only.

Enforce one active character per seat and one active seat per character within a session using partial unique constraints on `(session_id, seat_id)` and `(session_id, character_id)` where active. An account may own any number of characters and seats; it may not bind a character it does not own. Distinct seats may not share one character. This is a per-session exclusivity rule, not global character exclusivity.

The account that owns the seat selects/binds its own character at join or in lobby, before the first round opens. The host may admit/kick and may start only when every active player seat is bound and ready; host approval of the character choice is not required. For an approved late join, the joining account selects its character after admission approval and before the Room commits its scene-boundary entry. Unbound seats remain lobby/pending and cannot submit round actions, vote, or control combat.

On binding, validate ownership, current character legality, supported rules/catalog version, and absence of another live binding. Copy an immutable canonical character snapshot into this session binding. Later edits to the account character affect future bindings only. In-session advancement/state mutations update the session-owned snapshot, not the account's reusable source character. This follows ADR-016's explicit in-flight snapshot principle and ADR-003 event/snapshot replay model.

### 2. Lifecycle, deletion, and combat departure

- **Leave/kick/revoke:** revoke seat control under ADR-031/029; mark binding released at the same serialized transition. Historical session entity and event history remain usable for replay; the character is available for another session. Rejoin by the same account to the same live session reuses the same PC/entity and accumulated session state; it cannot silently choose a replacement. A different character requires a future explicit between-session/retired-seat flow.
- **Departure during combat:** retain the PC entity, HP, position, initiative, and history. On confirmed away/revocation, immediately decline its pending reactions as ADR-031 requires. On its turn, use ADR-031's Dodge/hold defensive autopilot (and its narrowed M4 behavior), then advance initiative normally. Do not despawn or transfer the PC to another seat. A kicked/revoked seat cannot regain control without a new host-approved admission, and re-entry still resolves to its existing binding.
- **Character deletion:** block deletion while any active binding exists. Deletion after release deletes the reusable character source; it does not mutate a running session snapshot. If deletion is legally required during a live session, redact source ownership and apply account-deletion scrub rules; preserve only the minimum session PC snapshot needed to keep game state coherent, with the anonymization behavior below.
- **Account deletion:** follow spec US-A4 AC3 and ADR-017/028 retention/deletion. Revoke seats, redact account/seat references in gameplay events, and scrub identifying character source data from live binding rows and event payloads using the same deletion job transaction. The session may continue with an anonymous DM-controlled PC/NPC, consistent with spec; retain non-identifying in-session mechanics only as needed for continuity. Do not retain an account-to-character link after deletion. Align scrub implementation with related cards `59c1a20e` and `fe153f81`; this ADR does not redefine their retention clocks.
- **Character swap:** no swap while a session is active. Between sessions, reuse any owned character that has no active binding. A replacement PC in a live session requires a separate explicit product/engine flow and must not overwrite the old event history.

### 3. Late join and legal spawn

Host approval remains required by spec §6.5 and ADR-031. Admission proceeds: request → host approval → table settings and mature opt-out/onboarding → character selection and validation → scene boundary/next between-round gate → legal placement → join commit. Do not admit the seat into the active party, expose a playable PC, or open its control path before all steps complete. Deliver the current table safety/content settings and a ≤150-word recap (spec US-S3) before the join commit; the joiner may opt out before any subsequent narration, per ADR-016.

Spawn only at a scene boundary or between combat rounds, never during an active turn/reaction window. The rules engine computes an available legal spawn cell from the scene's explicit player-entry spawn zone; if none is authored, use the nearest unoccupied legal cell to the party's designated entry anchor, tie-broken by row then column. Validate occupancy, terrain, map bounds, size, and reachability using ADR-018 engine rules. If no legal cell exists, keep the approved join pending until the next safe boundary or ask the host to select an engine-validated entry zone; never invent coordinates on the client/LLM. Late PC joins initiative at the next round start, not retroactively in the current round; exploration inclusion begins at the join commit.

### 4. Events, replay, commands, and authorization

Append event types: `SeatCharacterBound{seatId, characterId, characterRevision, snapshotHash}`, `SeatCharacterReleased{seatId, reason}`, and `LateJoinSpawned{seatId, entityId, sceneId, pos, initiativeEffectiveRound?}`. `SeatCharacterBound` is persisted before the corresponding `SeatJoined`/playable membership event; for initial lobby seats, ordering is bind → SeatJoined → (eventually) RoundOpened. For late join, persist approval and bound snapshot first, then at the boundary persist `EntityPlaced`/`LateJoinSpawned`, then `SeatJoined`; the next `RoundOpened` follows commit. These events and snapshots are replay-authoritative; replay never rereads mutable character rows.

WebSocket commands: `BindCharacter{characterId, expectedRevision, actionId}`, `RequestLateJoin{...}`, `ApproveLateJoin/DeclineLateJoin`, and `SelectLateJoinCharacter{characterId, expectedRevision, actionId}`. Bind/select must run through the Room serial mailbox and use idempotency keys. Every mutation checks current authenticated socket ticket, current non-revoked seat, account status, seat-account ownership, character ownership, session status, and binding uniqueness at commit time (ADR-029 §7 style; no trust in client-supplied account/seat/entity IDs). Host-only approval; seat owner alone chooses its character. Use existing join/control gate and per-seat mutation budget (ADR-029 §8); character binding consumes that budget. Reject stale revisions, cross-account selection, duplicate live bindings, and invalid state with neutral typed errors; do not persist rejected payloads. Repeated equivalent `actionId` returns its prior result.

### 5. Visibility and privacy

All seated clients may see bound character display name, class, ancestry/species, level, combat entity ID, position, initiative, and public HP/conditions as game state requires. Only the owning account may see/edit its reusable source character. Other seats do not receive source character revision, backstory/private notes, account identifiers, or raw binding ownership metadata. Host approval sees the proposed public character card needed for table readiness, not private account profile fields. `SeatCharacterBound` broadcast is projected to this public card; its private persistence payload/hash and account/character foreign keys are server-only. Account deletion scrubs identifiers while preserving only approved gameplay projection.

### 6. Migration and compatibility

No backfill from `sessions.character_id` to party seats: it is solo-only and ownership cannot safely be inferred for historical party events. Existing solo sessions remain unchanged and continue using `sessions.character_id`/`character`. Existing party seats with no binding are explicitly `unbound`; they cannot enter a new active round/combat until their owner binds a character. For already-active legacy parties, deploy a compatibility lobby gate: pause round opening, prompt each seat to bind once, then resume; do not guess or assign the solo owner character. Old SeatJoined events remain valid with no binding, and replay projects the seat as unbound. Additive nullable schema/migration first; new Room code tolerates missing binding records during rollout, while new gameplay mutations require binding. Rollback disables party start/join binding paths without deleting rows/events.

### 7. Alternatives considered

1. Put `character_id` directly on `SeatJoined` or `sessions`: rejected; event payload is not a mutable ownership store, and sessions-level ownership is wrong for multiple seats.
2. Reuse `sessions.character_id` for the host/player party: rejected; it is solo-only and cannot represent 2–6 distinct PCs.
3. Store only a character ID and load live account character data during play: rejected; later edits/deletion would rewrite running-session behavior and break replay.
4. Let host pick any seat's character or auto-assign a pregenerated character: rejected; removes account ownership/control and lacks product authorization.
5. Allow shared characters or mid-session swaps: rejected by default because resource/turn ownership becomes ambiguous and replay history forks.

## Ordered implementation breakdown

1. **Forge — schema and persistence.** Add additive migration, constraints, repository operations, character ownership/revision validation, immutable session snapshot, deletion/revocation scrubbing. Acceptance: concurrency attempts cannot create duplicate live seat/character bindings; solo paths and old unbound SeatJoined replay unchanged; account deletion leaves no account-character link and does not corrupt gameplay replay.
2. **Forge — Room identity projection and events.** Project seat→entity→snapshot into Room state; emit/replay binding/release events; gate every gameplay command against bound seat and current authorization. Acceptance: each accepted round action/rest ballot/reaction/control resolves the acting seat's one entity; cross-seat/client-forged IDs rejected; replay after restart yields identical ownership.
3. **Prism — lobby binding/readiness.** Owner-selectable character picker, readiness, public card, stale revision/ownership errors, solo compatibility. Acceptance: 2–6 seats bind distinct owned PCs; start blocked for unbound seats; another account cannot inspect/select source data.
4. **Forge + Prism — late join safe-entry flow.** Integrate request/host approval from #278 with settings/onboarding/recap, character binding, scene-boundary spawn selection, and next-round initiative. Acceptance: no current-round turn insertion; map occupancy/legal-cell invariant holds; settings/opt-out and recap precede first post-entry narration; no spawn yields pending, not unsafe placement.
5. **Proof — acceptance/regression suite.** Cover 2–6 seat binding, same-account multiple characters across sessions, duplicate binding race, edits after snapshot, leave/kick/rejoin, away turn/autopilot/reaction decline, character/account deletion, late join at exploration and combat boundaries, no legal spawn, event replay, legacy solo/unbound seats, and all authorization/rate limits. Acceptance: deterministic event traces match across replay and deletion tests assert scrubbed identifiers.
6. **Bastion — adversarial/privacy review.** Verify tenant isolation, forged identifiers, stale tickets/revoked seats, private character fields, retention/deletion card compatibility, and no private event data in broadcasts. Acceptance: review findings resolved or explicitly tracked before M4 gate.

## M4 dependency impact and open product questions

This decision is a prerequisite for M4 items **2** (action identity and eligible PCs), **4** (late join, leave/rejoin, PC autopilot), **6** (combat turn/reaction ownership), **7** (map entities/monster-vs-PC distinction), and **8** (party/map UI). The user specifically identified items 4, 6, 7, 8 as blocked; item 2 also requires the identity projection before its acceptance can be complete. Item 5 rest votes require seat identity for ballots but can implement vote mechanics independently against seat IDs; must integrate binding authorization before acceptance. Item 1 OOC chat and item 3 basic lobby controls can proceed independently, with item 3 readiness/start criteria dependent on binding.

**Needs owner confirmation (recommended defaults apply meanwhile):**

- Can two seats play the same pregenerated character? **Default: no; distinct character records and live binding per session.**
- Can a seat change characters between sessions? **Default: yes, select any owned character not actively bound elsewhere in that session.**
- Can a player replace a character mid-session? **Default: no; retire/leave then use a separately designed replacement flow.**
- Is host approval of the character selection required? **Default: no; host approves admission only, owner controls its PC.**

## Consequences

Party character ownership becomes explicit, auditable, and replay-stable; solo sessions retain their existing contract. The binding snapshot adds storage and deletion-scrub obligations. M4 cannot claim complete party combat or late-join PC entry until the ordered work above is integrated.
