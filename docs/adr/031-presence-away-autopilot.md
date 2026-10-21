# ADR-031: Presence, away transitions, and defensive autopilot

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 4 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-029 (round states, timers, pause)

Append-only: this ADR defines presence and autopilot contracts. It does not edit ADR-001 through ADR-030. Where ADR-005 is still Proposed, this ADR states the decision it needs and marks it as such. Where it narrows an earlier statement, it names the ADR and section.

## Context

- Spec §3.2 US-P5 AC1: a player disconnected for more than 30 s is marked away, and control is restored within 2 s of reconnect.
- Spec §9.1: reconnect and state restore complete within 3 s. This conflicts with the 2 s control restore in US-P5. This ADR states both (see Decision §3).
- Spec §3.5 AC2: a combat turn timer of 90 s; expiry resolves the turn as Dodge.
- Spec §6.1: the exploration round default is 120 s, host-configurable, with "off" allowed and a Resolve now control.
- Spec §6.3: a 15 s reaction window; defensive autopilot applies per A7.
- Spec §6.4: a seat drops out after 30 s; it is excluded from the spotlight; zero connected seats pauses the table.
- Spec A7: autopilot is defensive only.
- Spec A8: the spotlight gives every active player at least one direct prompt per 10 DM turns.
- Spec §13 Q7 asks whether autopilot may take part in votes. Chris's delegate decided it: autopilot never votes (§5.1 and §7).
- Architecture §2.2: active → paused on host pause or zero connected seats.
- ADR-005 (Proposed): a 120 s party round default; a 90 s combat turn timer; away seats (> 30 s) excluded from quorum; autopilot as a pure engine function.
- ADR-029 §2 and §8 define round states, the 5 s commit barrier, and the per-seat mutation budget. ADR-029 §8 refers to a "120 s round" that is not set anywhere. §Timer defaults below sets it.
- ADR-030 defines the rest vote and reads away state from this ADR.

## Decision

### 1. Presence states

Each seat is in exactly one presence state:

| State | Meaning |
|---|---|
| `connected` | Authenticated socket open and snapshot acknowledged. |
| `disconnected` | No open socket. The 30 s clock is running. |
| `away` | Disconnected for more than 30 s. Excluded from required sets and from quorum. |

Presence is engine state, stored in the Room (ADR-002). It is not a client flag.

### 2. Transitions and events

1. **Disconnect.** A socket close moves the seat to `disconnected` and emits `SeatDisconnected{seat, at}`.
2. **Away.** At 30 s of continuous `disconnected`, the seat moves to `away` and emits `SeatAway{seat, at}`.
3. **Reconnect.** A seat reconnects when an authenticated socket opens and the client acknowledges the snapshot. It then moves to `connected` and emits `SeatReconnected{seat, at, wasAway}`.
4. **Flap hysteresis.** A reconnect within 10 s of a disconnect cancels the pending transition, so the original 30 s clock is kept. The 10 s value is a starting value, tunable by amendment.
5. **No new clock on reconnect.** A seat that was `away` returns with `wasAway: true`. Its clock does not restart.

Events are appended to the log (ADR-003) and are visible to all seats.

### 3. Control restore and state restore

1. **Control restore: 2 s.** On a successful reconnect, the seat regains control of its own input within 2 s of the socket opening (US-P5 AC1). This covers input rights only.
2. **Full state restore: 3 s.** The full snapshot and replay complete within 3 s (§9.1).
3. **Both targets stand.** They measure different things. Control is restored within 2 s (US-P5 AC1, the M4 item 4 acceptance criterion). Full state sync completes within 3 s (§9.1). Neither replaces the other, and this ADR changes no spec number.
4. **Input during restore.** Input received before the snapshot ack is queued and processed after it, in receipt order (ADR-029 §1).

### 4. Effect of presence on rounds and combat

1. **Required sets.** An `away` seat is excluded from the required set of any round. A `disconnected` seat that has not yet reached `away` stays in the required set, so a 30 s blip does not change the round.
1a. **Rest-vote quorum.** An `away` seat is excluded from the quorum denominator of a rest vote (ADR-030 §2). A seat that becomes `away` while a vote is open leaves the denominator at that moment. Its cast vote is kept, and if it returns before close its vote still counts. A seat that is `disconnected` but not yet `away` stays in the denominator.
2. **Submissions kept.** A submission accepted before the seat went away is kept. A queued submission (ADR-029 §2) is kept and promoted in receipt order if the round is still open.
3. **No edits while disconnected.** A disconnected seat cannot edit or withdraw. A seat that is `away` returns with its committed state intact.
4. **Exploration.** An away PC does not submit an action. The party's PC follows the party. An away seat is excluded from the spotlight (§6.4), so A8's per-player prompt rule applies only to connected seats.
5. **Combat.** An away PC's turn is taken by autopilot as §5 defines. A committed action stays committed when the seat returns.
6. **Zero connected seats.** When no seat is `connected`, the table moves from `active` to `paused` (architecture §2.2). `away` seats do not count as connected. Pause freezes all timers (ADR-029 §5).
7. **Host away.** When the host is `away`, the table keeps running and nothing transfers automatically. Host actions wait for the host's return or a manual host reassignment outside this ADR. Pause and the tie-break in ADR-030 §3 use the host's recorded state as it stands.

### 5. Defensive autopilot

1. **Scope.** Autopilot acts only for an `away` PC during combat, and only on that PC's turn (A7). It never acts in exploration, never casts a rest vote, never submits a non-defensive action, and never speaks.
2. **Trigger.** Autopilot acts immediately when the away PC's combat turn begins. It does not wait for the 90 s turn timer.
3. **Engine function.** `autopilot(state, seat) -> command`. It is a pure function of the Room state and the seat. It uses no LLM and no judge call.
4. **Policy.** In order:
   1. Dodge. This is the default action on every turn.
   2. Move to cover if cover is within the PC's speed. If several cells qualify, the lowest cell ID wins, so the choice is deterministic.
   3. Use a healing potion only if the PC's HP is below 25%. Use no other consumable.
   4. No risky moves and no hazard entry.
   5. Reactions are auto-declined (§6.3 reaction window).
5. **Output.** Autopilot's command goes through the same rules engine path as a player command. It emits `AutopilotActed{seat, action, reason}` so the log shows what was done.
6. **No speaking.** Autopilot never produces chat, narration, or DM-facing text.

### 6. Reaction window

Reactions use the 15 s window in spec §6.3. When the reacting seat is `away`, the window is auto-declined at once, with reason `away`. No reaction is taken on the away PC's behalf except the decline.

### 7. Timer defaults

This section also states the round default that ADR-029 §8 refers to as "120 s round", which was not set anywhere before this ADR.

| Timer | Default | Source | Notes |
|---|---|---|---|
| Exploration round | 120 s | spec §6.1, ADR-005 | Host-configurable, "off" allowed, Resolve now control. |
| Combat turn | 90 s | spec §3.5 AC2, ADR-005 | Expiry resolves as Dodge. |
| Rest vote | 120 s | ADR-030 §4 | Fixed for M4. |
| Reaction window | 15 s | spec §6.3 | Auto-declined when the reacting seat is away. |
| Away threshold | 30 s | spec US-P5 AC1, §6.4 | Applies to disconnected seats. |
| Reconnect hysteresis | 10 s | this ADR §2.4 | Starting value, tunable by amendment. |

Pause freezes every timer in this table (ADR-029 §5).

## Alternatives considered

- **Auto-kick after 30 s.** Rejected: the spec defines away and drop-out, not removal. Removal needs a separate ADR.
- **Autopilot submits exploration actions.** Rejected: exploration choices are the player's. A defensive policy has no good default there (A7).
- **Autopilot votes on rest.** Rejected: autopilot never casts a vote (§5.1). Away seats leave the denominator instead (§4.1a).
- **Autopilot uses an LLM.** Rejected: a pure engine function is deterministic, testable, and needs no judge budget (ADR-005).
- **Host transfer on host away.** Rejected: not in the spec and it changes who owns pause and tie-break. Needs a separate decision.

## Consequences

- An away seat cannot slow a round or a combat turn beyond the existing timers.
- Autopilot gives every away PC a safe default action in combat. It does not make decisions for the player.
- Reconnect has two targets (2 s control, 3 s state), and tests must check both.
- M4 item 4 can start after this ADR is accepted.

## Decisions needed

Routine within delegation, flagged because they set behavior:

1. **Reconnect targets: 2 s control and 3 s state.** Decided by Chris's delegate: both stand as separate measures.
2. **Reconnect hysteresis of 10 s.** Accepted by Chris's delegate as a starting value, tunable by amendment.
3. **Q7, autopilot and votes.** Decided by Chris's delegate: autopilot never votes or submits a non-defensive action, and away seats leave the rest-vote denominator. Spec §13 Q7 remains open for Chris to close.
4. **Host away has no automatic transfer.** Recommendation: accept, and track host reassignment as a separate ADR.
5. **Autopilot policy in §5.4.** Recommendation: accept as the defensive default, since A7 requires defensive-only behavior and the spec gives no list.

## Verification

- Docs-only change: one new file, `docs/adr/031-presence-away-autopilot.md`. No existing ADR is edited. No code is written.
- Citations checked against `docs/spec.md` US-P5 AC1, §3.5 AC2, §6.1, §6.3, §6.4, §9.1, A7, A8, §13 Q7, `docs/architecture.md` §2.2, `docs/plan/m4-breakdown.md` items 4 and 5, ADR-002, ADR-003, ADR-005, ADR-029 §1, §2, §5, §8.
- `prettier --check` run against the branch head. Result recorded in the PR.
