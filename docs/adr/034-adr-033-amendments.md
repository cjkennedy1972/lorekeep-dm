# ADR-034: ADR-033 follow-ups and amendments

Status: Accepted (2026-10-25) · Date: 2026-10-22 · Owner: Sage · Depends on: ADR-002, ADR-003, ADR-022, ADR-029, ADR-030, ADR-031, ADR-033

Append-only: this ADR adds contracts and amends the merged ADR-030 and ADR-022 without editing them. It also amends ADR-033 (merged). Each amendment below names the section it changes and the ADR-033 lines it supersedes. Nothing here edits `docs/architecture.md`. Its event types are declared as additions to the v0.2 event list in architecture §15.6.

## Context

ADR-033 (combat turn and reaction orchestration) merged in `1a0a1db`. Review left the following points that ADR-033 cannot settle by editing merged ADRs:

- ADR-030 says "No vote during combat" and does not say what happens to an open vote.
- ADR-022 sets no tool scope for the combat narration turn.
- ADR-033 has no rule for hidden (stealthed) entities in reaction prompts.
- ADR-033 does not state that a host revoke can cost a turn.
- Sentinel asked for an explicit event name table and for real error codes in the admission rows.

## Decision

### 1. ADR-030 amendment: open rest vote at combat start

This amends ADR-030 §1.6 (preconditions), §4.8 (close reasons), §6.1 (event shape), and §8 (failed vote). The combat rule itself is ADR-030 "Decisions needed" item 5, "No vote during combat" (merged line 143). No normative ADR-030 section states it, and the §1.6 precondition list has no combat check. ADR-030 is not edited.

1. Combat start cancels any open rest vote immediately. The vote closes in the same mailbox pass as `CombatStarted`, and combat start is not delayed by the vote.
2. The cancelled close is a failed vote under ADR-030 §8. It emits `RestVoteClosed` only, applies no effects, emits no `RestApplied`, and changes no rest state. Its ballots are not counted in the tally. The §1.7 cooldown still starts, as for any close.
3. No vote can open until `CombatEnded`.
4. **One close mechanism.** The close is recorded by `closeReason`, not by a separate field. ADR-030 §6.1 names the close reason field `reason` in `RestVoteClosed{voteId, outcome, reason, yes, no}`. This ADR renames that field to `closeReason` for every rest-vote close. The rename applies to every ADR-030 use of `reason` for a vote close (§3, §4.8, §6.1, §7.2). Uses of `reason` for `rest-not-allowed` and `vote-closed` are error reasons under ADR-022 §2.4 and are unchanged.
5. **Close enum.** The ADR-030 §4.8 close enum gains `cancelled-combat` as a `closeReason`. The one form of a combat-cancelled close is the pair `outcome: failed` with `closeReason: cancelled-combat`, the existing failed value that §8 uses. No outcome is applied to the rest state.
6. ADR-033 D12 and D20 wrote the close as "outcome `cancelled-combat`". That wording is superseded by items 4 and 5 (see §6 item 3).

### 2. ADR-022 amendment: combat narration tool scope

This sets the tool scope for one turn class, using the ADR-022 sections it touches: §2 (the M2 tool set), §2.3 (tool list), §2.4 (error codes), §1 T5 (writes boundary), and §4.2 (turn-level fallback). ADR-022 is not edited.

1. A combat narration turn (ADR-033 §6.2, `phase: narrating`) exposes read-only tools only: the two read-only entries in ADR-022 §2.3, item 10 and item 17 (`rules_lookup`). No state-changing tool is offered (ADR-033 §6.7).
2. If the model still emits a state-changing call on that turn, the engine rejects it with a §2.4 code and does not apply it. ADR-022 §1 T5 holds: only `apply()` writes state.
3. ADR-022 §1 T3 (eight calls) and T4 (two retries) apply unchanged. A turn that falls back uses §4.2.
4. This scope is a new contract. ADR-022 sets no tool scope for the narration turn. The engine has already applied the mechanics (ADR-033 §6.7), so read-only tools cost the narration nothing it needs.

### 3. Hidden (stealthed) entities in reaction prompts

This amends ADR-033 §3.1 and §3.2 for hidden entities.

1. If the reacting entity is hidden from a seat (ADR-033 §3.2, visibility split), the reaction prompt and `reactorEntityId` go only to the controlling seat. Other seats see nothing about the prompt: no "prompt open", no deadline.
2. The log keeps the full record. The engine appends `ReactionPromptOpened`, `ReactionAnswered`, or `ReactionDeclined` with the full payload, and the server applies this visibility rule to every seat's broadcast, snapshot, and replay.
3. A hidden reactor's prompt does not change phase timing. Its window runs under ADR-033 §3.5 (expiry) and §3.7 (pause).

### 4. Host revoke can cost a turn (intended)

1. If the host revokes the controlling seat of the active combatant, the turn's bounded resolution (ADR-033 §5.5) applies at once. The timeout action (Dodge or hold, §5.3) is applied, so the turn is spent.
2. This is intended. A revoked seat cannot act, and the table does not wait for it.
3. The host revoke is not a combat command. It is a seat revocation (ADR-031 §2 item 7), so the admission table in ADR-033 §1 does not gate it.

### 5. Event names for architecture §15.6

These are the combat and rest events declared for §15.6. ADR-033 §7.1 declares the combat list. The table below is the complete set for this decision.

| Event | Payload | Declared by | Visibility |
|---|---|---|---|
| `CombatStarted` | `{encounterId, order}` | ADR-033 §7.1 | all seats |
| `CombatEnded` | `{encounterId}` | ADR-033 §7.1 | all seats |
| `TurnOpened` | `{turnId, entityId, deadline}` | ADR-033 §7.1 | all seats |
| `TurnTimedOut` | `{turnId, entityId, action}` | ADR-033 §7.1 | all seats |
| `TurnResolved` | `{turnId, entityId, eventIds}` | ADR-033 §7.1 | log and DM input |
| `MoveStarted` | `{turnId, entityId, path}` | ADR-033 §7.1 | all seats |
| `MoveEnded` | `{turnId, entityId, reason}`, `reason` ∈ ADR-033 §4.6 | ADR-033 §7.1 | all seats |
| `ReactionPromptOpened`, non-controlling seats, visible reactor | `{promptId, reactorEntityId, reactorSeat, deadline}` | ADR-033 §3.1 | non-controlling seats |
| `ReactionPromptOpened`, non-controlling seats, hidden reactor | nothing is sent (§3 item 1) | this ADR §3 | none |
| `ReactionPromptOpened`, controlling seat | full form: `{promptId, reactorEntityId, reactorSeat, deadline, trigger, options}` | ADR-033 §3.1, §3.2 | controlling seat only |
| `ReactionAnswered` | `{promptId, answer}` | ADR-033 §7.1 | all seats, unless hidden (§3 of this ADR) |
| `ReactionDeclined` | `{promptId, cause}`, `cause` ∈ `timeout`, `presence`, `no-controller`, `cap`, `restart` | ADR-033 §7.1 | all seats, unless hidden |
| `NarrationCommitted` | `{turnId, narrationId}` | ADR-033 §7.1 | all seats |
| `RestVoteClosed` | `{voteId, outcome, closeReason, yes, no}` | ADR-030 §6.1, field renamed by §1 item 4 | all seats |

The same split applies to the snapshot and to replay: a non-controlling seat sees a hidden reactor's prompt not at all, and a visible reactor's prompt as the broadcast form.

`RestVoteOpened`, `RestVoteCast`, `RestVoteCastNotice`, and `RestApplied` keep ADR-030 §6.1 payloads unchanged. `ReactionAvailable` is an M1 engine event and is not declared here.

### 6. Real error codes and supersessions for ADR-033

These codes are declared here as an extension of the ADR-022 §2.4 enum, as ADR-030 does for its codes. ADR-022 is not edited.

1. Phase names and error codes are different things. The admission table in ADR-033 §1 is restated with codes below.

| Phase | Accepted | Rejected code |
|---|---|---|
| `awaiting-command` | Controlling seat: move, action, bonus action, `end-turn` | Other seats: `not-your-turn`. Chat is always allowed. |
| `moving` | Engine continuation only. Bounded resolution (ADR-033 §5.5) and timer expiry (§5.3) apply. | Controlling seat: `move-in-progress`. Other seats: `not-your-turn`. Not queued. |
| `reaction-pending` | Reaction answers only: `use{handle}` or `decline`, from the controlling seat of the reacting entity. Bounded resolution and timer expiry still apply. | Every other command: `reaction-window-open`. Not queued. |
| `narrating` | Pause only (ADR-029 §5) | Every combat command: `narration-in-progress`. Not queued. |

2. Codes new to this ADR: `move-in-progress`, `reaction-window-open`, `narration-in-progress`, `not-your-turn`, `combat-start-unauthorized`.
3. **Supersessions.** This ADR supersedes these ADR-033 lines:
   - §1 admission table, the `narrating` row. The code is `narration-in-progress`, not the phase name.
   - §1 admission table, the `reaction-pending` row. The rejected code is `reaction-window-open`. `reaction-pending` is the phase name only.
   - §1 admission rule 1, which says the turn commands are "accepted only in `awaiting-command`". That is still true, and the table governs.
   - §3.1, `ReactionPromptOpened` payload. The broadcast and private forms are given in §5 of this ADR.
   - §3.2, the sentence "Other seats see only 'prompt open' and its deadline", for hidden reactors only. §3 item 1 of this ADR replaces it. Visible reactors keep the §3.1 broadcast.
   - §8 "Rest votes" bullet, replaced by §1 of this ADR.
   - D12, replaced by §1 of this ADR. Its "outcome `cancelled-combat`" wording is replaced by `closeReason: cancelled-combat` with `outcome: failed` (§1 items 4 and 5).
   - D20, same replacement as D12.
   - D19, its sentence "the only inputs honored are reaction answers when a window opens". Replaced by item 4 below.
4. **Corrected D19.** ADR-033 D19 says "the only inputs honored are reaction answers when a window opens". Replace that sentence with: reaction answers are accepted only in `reaction-pending`, from the controlling seat of the reacting entity. Bounded-resolution paths (ADR-033 §5.5) and timer expiry (§5.3) apply in any phase where a turn is open. Reaction windows open only by moving the Room to `reaction-pending` (ADR-033 §4.2), in the same mailbox pass as the triggering step. The `moving` phase runs the path to its end or to a §4 stop, and no command interrupts it.
5. **Combat start authority.** An encounter starts only from an engine-validated DM tool call, `start_combat` (ADR-022 §2.3 item 7), made during an active round. The engine validates it and rejects it with the codes ADR-022 §2.3 item 7 lists (`unknown-monster`, `already-in-combat`, `no-spawn-space`, `enemy-cap-exceeded`). Player text and host text never start combat. The host has no command that starts combat. A host request reaches the DM only as input text, and the DM may or may not call `start_combat`. Any attempt to start combat from any other source, including a player or host command of any kind and text routed as a command, is rejected with `combat-start-unauthorized` and applies no state change.

## Alternatives considered

- **Keep `reason` in `RestVoteClosed` and add `cancelled-combat` only.** Rejected. Two names for one field across rest and combat closes would make `closeReason` mean different things in different events. One name is simpler to test.
- **Let the host or a moderator decide whether a hidden reactor's prompt is visible to others.** Rejected. It adds an authority path. Hidden is a fact the engine tracks, so the rule is mechanical.
- **Delay the turn timeout until the host re-assigns control after a revoke.** Rejected. The table would stall on the revoked seat. ADR-033 §5.5 already resolves a revoked controller at once.

## Consequences

- ADR-030 and ADR-022 each gain one amendment note. Neither is edited, and ADR-030 §6.1 field rename is the only change to a merged payload.
- Hidden reactors cost no extra events. The log keeps the full record and the broadcast is split.
- Each combat close, including `cancelled-combat`, has one field name, `closeReason`.

## Verification

- Docs-only change: one new file, `docs/adr/034-adr-033-amendments.md`. No existing ADR or `docs/architecture.md` is edited.
- Read: ADR-030 (§§1.6, 1.7, 4.8, 6.1, 7.2, 8, "Decisions needed" item 5 at merged line 143), ADR-022 (§§1 T3–T5, 2.3 items 7, 10, 17, 2.4, 4.2), ADR-033 as merged in `1a0a1db` (§§1, 3, 4, 5, 6, 7, 8, D12, D19, D20).
- Not verified: the full ADR-031 text on hidden-entity presence; the architecture §15.6 current event list. §5 of this ADR states the complete set for this decision.
- Prettier is run on this file before commit.

## Status update (2026-10-25)

Accepted. Merged in `b64b02d` (#270). The decision text above is unchanged. Checked against `origin/main` (27a1347, #309):

- **§1 rest-vote cancel on combat start:** shipped. `cancelRestVoteForCombat()` in `apps/server/src/room/restVote.ts` returns `outcome: failed` with `closeReason: cancelled-combat`, and `Room.ts` applies it in the same mailbox pass as `CombatStarted`. The code emits the field as `closeReason`, so the §1 rename matches shipped code. ADR-030's own text still says `reason` and stays unedited, as the amendment requires.
- **§6 admission codes:** `not-your-turn`, `move-in-progress`, `reaction-window-open`, and `narration-in-progress` are shipped in `combat.ts`. `seat-mismatch`, `prompt-closed`, and `combat-start-unauthorized` are not in the tree yet.
- **§3 hidden reactors and §5 event split:** not implemented. Depends on the reaction prompt events, which ADR-033 §7.1 declares but the code does not emit (see the ADR-033 status update).
- **§2 combat narration tool scope and §4 host-revoke behavior:** not verified in code. Narration turns are not implemented yet, and no bounded revoke path was found.

No code was changed by this status update.

## Addendum (2026-10-25): hidden entities in client game state and events

Recorded with PR #325 (card 2636a005). This extends §3 from reaction prompts to everything the server serializes to a client. Nothing above is changed.

1. **Removal for non-controllers.** For every viewer except the controlling seat, a hidden entity is removed outright from `combatRoom` in `StateSync` (including checkpoints and reconnect or `Resync`) and from `CombatTracker`: entity record (no position, no HP, no existence), initiative, resources, dodge, concentration, and an open reaction whose reactor it is. The controlling seat receives it in full.
2. **Active token.** While an entity hidden from a viewer acts, that viewer's `activeEntityId` is `null`. There is no fallback to the next visible combatant, and clients show no active token (an "unseen creature is acting" notice instead).
3. **Committed events.** Each committed combat event type declares which fields hold entity ids (`apps/server/src/room/eventVisibility.ts`). An event whose subject id is hidden from a viewer is not sent to that viewer; hidden ids are removed from list fields (`CombatStarted.order` and `combatants`, `AreaResolved.affected`). An event type with no declaration is sent to no one (fail closed), and a test fails when the engine or room adds an undeclared type. The narration filter uses the same declarations. Clients never use `initiative[0]` as the active token.
4. **Engine-only fields.** `combatRoom.seed` and `combatRoom.engineReactions` are never sent to any client.
5. **Public PC set (ADR-035).** For a character another seat controls, clients receive only name, kind, team, HP, max HP and position; AC, speed, abilities, saves and attacks go to the controller only. Visible monsters keep their full stats for now (revisit in M5 hardening, card ec1aa627).
6. **Unchanged.** Authoritative state, the event log, replay and persistence are not altered; this is a per-viewer projection.
