# ADR-034: ADR-033 follow-ups and amendments

Status: Proposed (draft PR) · Date: 2026-10-22 · Owner: Sage · Depends on: ADR-002, ADR-003, ADR-022, ADR-029, ADR-030, ADR-031, ADR-033

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

This amends ADR-030 §1.6 (preconditions) and the combat rule at ADR-030 §5 "No vote during combat" (the combat line at merged line 143). ADR-030 is not edited.

1. Combat start cancels any open rest vote immediately. The vote closes with `closeReason: cancelled-combat`, the same moment `CombatStarted` is applied, in the same mailbox pass.
2. A `cancelled-combat` close is a failed vote under ADR-030: it applies no outcome and changes no rest state. It is not counted as a yes or a no in the tally, and no seat is marked as having voted.
3. Combat start is not delayed by the vote.
4. No vote can open until `CombatEnded`.
5. **Field name.** ADR-030 §6.1 names the close reason field `reason` in `RestVoteClosed{voteId, outcome, reason, yes, no}`. This ADR renames that field to `closeReason` for every rest-vote close, and adds `cancelled-combat` to the close enum. The rename applies to ADR-030 §3, §4, §6.1, and §7.2, which all say `reason`. Other ADR-030 uses of `reason` for `rest-not-allowed` and `vote-closed` are ADR-022 §2.4 error reasons and are unchanged.
6. The close enum gains `cancelled-combat`. Its meaning is the one in item 2.

### 2. ADR-022 amendment: combat narration tool scope

This amends ADR-022 §2.3 and §4.1 for one turn class. ADR-022 is not edited.

1. A combat narration turn (ADR-033 §6.2, `phase: narrating`) exposes read-only tools only: the two read-only entries in ADR-022 §2.3 (items 10 and 17, `rules_lookup` among them). No state-changing tool is offered.
2. ADR-022 T3 (eight calls) and T4 apply unchanged to that turn.
3. This restriction is a new contract. ADR-022 sets no tool scope. Mechanics are already applied by the engine (ADR-033 §6.7), so the restriction costs the narration nothing it needs.

### 3. Hidden (stealthed) entities in reaction prompts

This amends ADR-033 §3.1 and §3.2 for hidden entities.

1. If the reacting entity is hidden from a seat (ADR-033 §3.2, visibility split), the reaction prompt and `reactorEntityId` go only to the controlling seat. Other seats see nothing about the prompt: no "prompt open", no deadline.
2. The log keeps the full record. The engine appends `ReactionPromptOpened`, `ReactionAnswered`, or `ReactionDeclined` with the full payload, and the server applies this visibility rule to every seat's broadcast, snapshot, and replay.
3. A hidden reactor's prompt does not change phase timing. Its window runs as §3.4 of ADR-033 says.

### 4. Host revoke can cost a turn (intended)

1. If the host revokes the controlling seat of the active combatant, the turn's bounded resolution (ADR-033 §5.5) applies at once. The timeout action (Dodge or hold, §5.3) is applied, so the turn is spent.
2. This is intended. A revoked seat cannot act, and the table does not wait for it.
3. The host revoke is not a combat command. It is a membership action under ADR-029 §7 and is not subject to the admission table.

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
| `ReactionPromptOpened` | `{promptId, reactorEntityId, reactorSeat, deadline}` (broadcast); `{trigger, options}` (private to controlling seat) | ADR-033 §7.1, split by §3 of this ADR | see split |
| `ReactionAnswered` | `{promptId, answer}` | ADR-033 §7.1 | all seats, unless hidden (§3 of this ADR) |
| `ReactionDeclined` | `{promptId, cause}`, `cause` ∈ `timeout`, `presence`, `no-controller`, `cap`, `restart` | ADR-033 §7.1 | all seats, unless hidden |
| `NarrationCommitted` | `{turnId, narrationId}` | ADR-033 §7.1 | all seats |
| `RestVoteClosed` | `{voteId, outcome, closeReason, yes, no}` | ADR-030 §6.1, field renamed by §1.5 | all seats |

`RestVoteOpened`, `RestVoteCast`, `RestVoteCastNotice`, and `RestApplied` keep ADR-030 §6.1 payloads unchanged. `ReactionAvailable` is an M1 engine event and is not declared here.

### 6. Real error codes and supersessions for ADR-033

These codes are declared here as an extension of the ADR-022 §2.4 enum, as ADR-030 does for its codes. ADR-022 is not edited.

1. Phase names and error codes are different things. The admission table in ADR-033 §1 is restated with codes below.

| Phase | Accepted | Rejected code |
|---|---|---|
| `awaiting-command` | Controlling seat: move, action, bonus action, `end-turn` | Other seats: `not-your-turn`. Chat is always allowed. |
| `moving` | Engine continuation only. Bounded resolution (ADR-033 §5.5) and timer expiry (§5.3) apply. | Controlling seat: `move-in-progress` |
| `reaction-pending` | Reacting entity's controlling seat: `use{handle}` or `decline`. Bounded resolution and timer expiry still apply. | Every other command: `reaction-pending`. Not queued. |
| `narrating` | Pause only (ADR-029 §5) | Every combat command: `narration-in-progress`. Not queued. |

2. Codes new to this ADR: `move-in-progress`, `reaction-pending`, `narration-in-progress`, `not-your-turn`, `combat-active`, `prompt-closed`, `seat-mismatch`, `rate-limited`.
3. **Supersessions.** This ADR supersedes these ADR-033 lines:
   - §1 admission table, the `narrating` row. The code is `narration-in-progress`, not the phase name.
   - §1 admission table, the `reaction-pending` row. The code is `reaction-pending`, which is distinct from the phase name `reaction-pending`.
   - §1 admission rule 1, which says the turn commands are "accepted only in `awaiting-command`". That is still true, and the table governs.
   - §3.1, `ReactionPromptOpened` payload. §3.1 and §7.1 are replaced by §5 of this ADR.
   - §8 "Rest votes" bullet, replaced by §1 of this ADR.
   - D12, replaced by §1 of this ADR.
4. **Clarification of D19.** Reaction windows open by moving the Room to `reaction-pending` (ADR-033 §4.2). This is the only way a window opens. The `moving` phase runs the path to its end or to the §4 stop, and no command interrupts it. The window opens within the same mailbox pass as the triggering step.

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
- Read: ADR-030 (§§1.6, 3, 4, 5, 6.1, 7.2, and the combat line at merged line 143), ADR-022 (§§2.3, 2.4, 4.1), ADR-033 as merged in `1a0a1db` (§§1, 3, 4, 5, 6, 7, 8, D12, D19).
- Not verified: the full ADR-031 text on hidden-entity presence; the architecture §15.6 current event list. §5 of this ADR states the complete set for this decision.
- Prettier is run on this file before commit.
