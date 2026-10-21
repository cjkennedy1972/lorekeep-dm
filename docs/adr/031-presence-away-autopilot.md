# ADR-031: Presence, away transitions, and defensive autopilot

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 4 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-014 (WebSocket ticket), ADR-029 (round states, timers, pause, §7 authorization), ADR-030 (reads away state)

Append-only: this ADR defines presence and autopilot contracts. It does not edit ADR-001 through ADR-030 or `docs/architecture.md`. Its event types are declared as additions to the v0.2 event list in architecture §15.6, as ADR-030 does. Where ADR-005 is still Proposed, this ADR states the decision it needs and marks it as such.

## Context

- Spec §3.2 US-P5 AC1: a player disconnected for more than 30 s is marked away, and control is restored within 2 s of reconnect.
- Spec §9.1: reconnect and full state restore complete within 3 s. US-P5 measures control and §9.1 measures full state, so they are separate targets (§3).
- Spec §3.5 AC2: a combat turn timer of 90 s; expiry resolves the turn as Dodge.
- Spec §6.1: the exploration round default is 120 s, host-configurable, with "off" allowed and a Resolve now control.
- Spec §6.3: a 15 s reaction window; defensive autopilot applies per A7.
- Spec §6.4: a seat drops out after 30 s and is excluded from the spotlight. Drop-in is governed by §6.4. Zero connected seats pauses the table.
- Spec §6.5: the host approves or denies late joiners.
- Spec A7: autopilot is defensive only. Spec A8: the spotlight gives every active player at least one direct prompt per 10 DM turns.
- Spec §13 Q7 asks whether autopilot may take part in votes. Chris's delegate decided it does not (§5.1). Q7 stays open for Chris to close.
- Architecture §2.2: active → paused on host pause or zero confirmed-connected seats.
- ADR-029 §7: every chat send re-checks the socket's ticket, the seat, and its retirement and mute state.
- ADR-005 (Proposed): a 120 s party round default; a 90 s combat turn timer; away seats excluded from quorum; autopilot as a pure engine function.
- ADR-029 §8 refers to a "120 s round" that is not set anywhere. §7 below sets it.
- ADR-030 defines the rest vote and reads away state from this ADR.

## Decision

### 1. Presence states

Each seat is in exactly one presence state. Presence is engine state in the Room (ADR-002), not a client flag.

| State | Meaning | Control | Confirmed-connected |
|---|---|---|---|
| `connected` | Socket open, snapshot acked, and held for 10 s (§2.4). | Yes | Yes |
| `returning` | Socket open and snapshot acked, held less than 10 s. | Yes, from 2 s (§3.1) | No |
| `disconnected` | Socket closed. The 30 s away clock is running. | No | No |
| `away` | Disconnected for 30 s on a running server. Excluded from required sets and quorum. | No | No |
| `unknown` | Presence not known after a server restart or a missed heartbeat (§2.6). | No | No |
| `revoked` | Seat removed by kick, ban, retirement, or departure (§2.7). Terminal for that seat. | No | No |

A seat gets control only after the re-check in §3.5 passes. Only confirmed-connected seats count toward the pause rule (§4.7).

### 2. Transitions and events

1. **Disconnect.** A socket close moves the seat to `disconnected` and starts the 30 s clock. `SeatDisconnected{seat, at}` is emitted only if the seat is still `disconnected` after 10 s (§2.5), so a blip leaves no event.
2. **Away.** At 30 s of continuous `disconnected` on a running server, the seat moves to `away` and emits `SeatAway{seat, at}`.
3. **Return.** A socket that passes the §3.5 check and gets a snapshot ack moves the seat to `returning` and restores control within 2 s. A `disconnected` seat that returns before 30 s stops its clock. An `away` seat stays `away` until it reaches `connected`.
4. **Hold.** A `returning` seat becomes `connected` after 10 s without a socket drop. It emits `SeatReconnected{seat, at, wasAway}` if an event was emitted for its disconnect. `wasAway` is true only when the seat came back from `away`.
5. **Hysteresis on both edges.** The 10 s value applies to entering `disconnected` (point 1) and leaving `away` (point 4). A drop during `returning` goes back to `disconnected`, and the away clock keeps its original start. A seat that was `away` and drops during `returning` goes back to `away`. Entering or leaving `away` never restarts the clock.
6. **Unknown.** At server restart every seat moves to `unknown`, and no away clock runs. A `connected` or `returning` seat whose heartbeat is missing past the limit (Decision item 6) moves to `unknown`. A seat leaves `unknown` only through point 3. `unknown` never becomes `away` by time, so autopilot never acts on it (§5.1).
7. **Revoked.** Removal moves the seat to `revoked` at once, with no clock. It emits `SeatRevoked{seat, at, cause}`, where `cause` is `kick`, `ban`, `retired`, or `departed`. A revoked seat returns only through a new authorization (§8.1).
8. **Event rate limit.** At most one presence event per seat per 10 s. A transition inside that window is merged into the next event, and the log records the state that holds at the window's end. State changes apply immediately and only event emission is coalesced. The snapshot always holds the current state.

Event types declared as additions to architecture §15.6: `SeatDisconnected`, `SeatAway`, `SeatReconnected`, `SeatRevoked`, `SeatTakenOver`, `AutopilotActed`. All are appended to the log (ADR-003) and visible to all seats.

### 3. Control restore, state restore, and re-check

1. **Control restore: 2 s.** Within 2 s of the socket opening, and after the §3.5 check passes, the seat regains input rights (US-P5 AC1). This covers input rights only.
2. **Full state restore: 3 s.** The full snapshot and replay complete within 3 s (§9.1).
3. **Both targets stand.** They measure different things. Neither replaces the other, and this ADR changes no spec number.
4. **Input during restore.** Input received before the snapshot ack is queued and processed after it, in receipt order (ADR-029 §1).
5. **Re-check on every return.** Before a return gets control, run the ADR-029 §7 check on the socket's ticket: the ticket is valid and not revoked (ADR-014), the seat is still seated, and it is not retired or muted. If the check fails, the socket is closed with an auth error. No `SeatReconnected` is emitted, control is not granted, and the presence state does not change. Because "not muted" is part of the check, a muted seat cannot regain control on return (Decision item 7).
6. **Takeover.** A second socket for a seat that already has an open socket runs the same check. If it passes, the new socket is acked and then the first socket is closed, so the seat never has zero sockets. Presence does not change, and no disconnect or away clock starts. If the check or the ack fails, the first socket is untouched. A seat has at most one socket at a time. A takeover emits `SeatTakenOver{seat, at}`.

### 4. Effect of presence on rounds and combat

1. **Required sets.** `away` and `revoked` seats are excluded from the required set of any round. `disconnected`, `returning`, and `unknown` seats stay in it, so a 30 s blip does not change a round.
2. **Rest-vote quorum (ADR-030 §2).** An `away` or `revoked` seat leaves the quorum denominator at that moment. `disconnected`, `returning`, and `unknown` seats stay in it.
   - An `away` seat's cast ballot is kept. If the seat reaches `connected` again before close, the ballot counts again.
   - An `away` seat cannot cast. A cast needs control (§3.1).
   - A `revoked` seat's ballot is voided, and the seat does not re-enter the denominator.
3. **Submissions kept.** A submission accepted before the seat went away is kept. A queued submission (ADR-029 §2) is kept and promoted in receipt order if the round is still open.
4. **No edits without control.** A seat without control cannot edit or withdraw. A `returning` seat has control from 2 s. `disconnected` and `unknown` seats do not.
5. **Exploration.** An away PC does not submit an action. The party's PC follows the party. Spotlight prompts (A8) go only to connected seats. `away`, `revoked`, and `unknown` seats are excluded.
6. **Combat.** A confirmed `away` PC's turn is taken by autopilot (§5). A committed action stays committed when the seat returns, unless the returning seat replaces it (item 8).
7. **Zero confirmed-connected seats.** When no seat is `connected`, the table moves from `active` to `paused` (architecture §2.2). `returning`, `disconnected`, `away`, `unknown`, and `revoked` do not count. Pause freezes all timers (ADR-029 §5). Resume follows ADR-029 §5.
8. **Replacement of autopilot commands.** Until the turn resolves, a returning seat's command replaces an autopilot-committed command. The replacement is a normal player command. It counts against the ADR-029 §8 per-seat budget and is applied in receipt order. The log keeps the `AutopilotActed` event followed by the seat's command.
9. **Host.** When the host is `away`, the table keeps running and nothing transfers automatically. When the host is `revoked`, host actions are unavailable until a manual host reassignment outside this ADR. Pause and the tie-break in ADR-030 §3 use the host's recorded state as it stands.

### 5. Defensive autopilot

1. **Scope.** Autopilot acts only for a confirmed `away` PC, during combat, on that PC's turn (A7). It never acts for `unknown`, `disconnected`, `returning`, or `revoked` seats. It never acts in exploration, never casts a rest vote, never submits a non-defensive action, and never speaks.
2. **Trigger.** It acts when the away PC's combat turn begins. If the seat becomes `away` during its own turn, it acts at that moment. It does not wait for the 90 s turn timer.
3. **Engine function.** `autopilot(state, seat) -> command`. It is a pure function of the Room state and the seat. It reads only engine state: positions, HP, turn order, conditions, and concentration. It never reads chat, player text, or LLM output. It uses no LLM and no judge call.
4. **Policy: Dodge or hold only.** M4 has no movement for autopilot. It takes no move, cover, opportunity attack, consumable, spell, or hazard action.
   1. Dodge is the default and only action.
   2. If Dodge cannot be taken, hold: end the turn with no action.
   3. Reactions are declined (§6).
5. **Concentration.** Dodge does not break concentration. Autopilot never starts, ends, or changes a concentration effect.
6. **Output.** The command goes through the same rules engine path as a player command and emits `AutopilotActed{seat, action, reason}`. `action` is `dodge` or `hold`. `reason` is a fixed enum with two values: `away-at-turn-start` and `away-mid-turn`.
7. **No speaking.** Autopilot never produces chat, narration, or DM-facing text.
8. **Unknown seats.** Autopilot does not act for an `unknown` seat. The 90 s turn timer resolves its turn as Dodge (spec §3.5). If no seat is connected, the table is paused (§4.7).

### 6. Reaction window

Reactions use the 15 s window in spec §6.3. When the reacting seat is `away`, `revoked`, or `unknown`, the window is auto-declined at once. A `returning` seat keeps its window. No reaction is taken on the away PC's behalf except the decline.

### 7. Timer and threshold defaults

This section sets the "120 s round" default that ADR-029 §8 refers to. It was not set anywhere before this ADR.

| Timer or threshold | Default | Source | Notes |
|---|---|---|---|
| Exploration round | 120 s | spec §6.1, ADR-005 | Host-configurable, "off" allowed, Resolve now control. |
| Combat turn | 90 s | spec §3.5 AC2, ADR-005 | Expiry resolves as Dodge. |
| Rest vote | 120 s | ADR-030 §4 | Fixed for M4. |
| Reaction window | 15 s | spec §6.3 | Auto-declined for `away`, `revoked`, and `unknown` seats. |
| Away threshold | 30 s | spec US-P5 AC1, §6.4 | Applies to `disconnected` seats on a running server. |
| Hysteresis on both edges | 10 s | §2.5 | Starting value, tunable by amendment. |
| Presence event window | 10 s | §2.8 | Coalesces presence events. |
| Heartbeat missed limit | Not set | §2.6 | Decision item 6. |

Pause freezes every timer in this table (ADR-029 §5).

## Seat claim and entry

1. **Reclaim.** Only the owning account can reclaim its `away` seat. The return passes the §3.5 check, which ties the ticket to the seat's owner. Another account cannot claim the seat. If the owner does not return, the host can retire the seat. That moves it to `revoked` with cause `retired` (spec §6.4).
2. **New seats.** A new seat exists only after its own authorization: the host approves the joiner (spec §6.5). On approval and snapshot ack, the seat starts `returning` and becomes `connected` after 10 s, like any return. A denied joiner gets no seat and no presence.
3. **Drop-in.** Drop-in placement, the scene-boundary rule, and the initiative rule are spec §6.4 and are M4 scope. This ADR governs presence only and does not change them.

## Alternatives considered

- **Auto-kick after 30 s.** Rejected: the spec defines away and drop-out, not removal. Removal needs a separate ADR.
- **Autopilot submits exploration actions.** Rejected: exploration choices are the player's. A defensive policy has no good default there (A7).
- **Autopilot votes on rest.** Rejected: autopilot never casts a vote (§5.1). Away seats leave the denominator instead (§4.2).
- **Autopilot moves to cover or uses consumables in M4.** Rejected: M4 has no movement and no consumable use by autopilot (§5.4).
- **Autopilot uses an LLM.** Rejected: a pure engine function is deterministic, testable, and needs no judge budget (ADR-005).
- **Host transfer on host away.** Rejected: not in the spec, and it changes who owns pause and tie-break. Needs a separate decision.
- **A second socket replaces the first without a check.** Rejected: a takeover is a return and goes through §3.5.

## Consequences

- An away seat cannot slow a round or a combat turn beyond the existing timers.
- Autopilot gives an away PC a safe default in combat: Dodge, or hold. It never plays the player's turn.
- Presence has six states. Tests must cover each transition, both reconnect targets (2 s control and 3 s state), hysteresis on both edges, and the fail-closed `unknown` state.
- M4 item 4 can start after this ADR is accepted.

## Decisions needed

Routine within delegation, flagged because they set behavior:

1. **Reconnect targets: 2 s control and 3 s state.** Decided by Chris's delegate: both stand as separate measures.
2. **10 s hysteresis on both edges.** Accepted by Chris's delegate as a starting value, tunable by amendment.
3. **Q7, autopilot and votes.** Decided by Chris's delegate: autopilot never votes or submits a non-defensive action, and away seats leave the rest-vote denominator. Spec §13 Q7 remains open for Chris to close.
4. **Host away and host revoked have no automatic transfer.** Recommendation: accept, and track host reassignment as a separate ADR.
5. **Autopilot is Dodge or hold only.** Decided by Atlas for M4: no movement, no cover moves, no opportunity attacks, no consumables.
6. **Heartbeat interval and missed-heartbeat limit.** Not set in ADR-029 or any transport ADR, and needed before M4 item 4 can be built. Recommendation: set both in the transport ADR. This ADR names only the condition.
7. **Muted seat on return.** The ADR-029 §7 check includes "not muted", so a muted seat cannot regain control on return (§3.5). Mute is a chat restriction in the spec. Atlas to confirm this literal reading, or to split the check so mute blocks chat only.
8. **Reclaim is owner-only; drop-in stays in M4 scope.** Decided by Atlas, per spec §6.4 and §6.5.
9. **A returning seat may replace an autopilot command until the turn resolves.** Decided by Atlas.

## Verification

- Docs-only change: one file, `docs/adr/031-presence-away-autopilot.md`. No existing ADR and no `docs/architecture.md` change. No code is written.
- Citations checked against `docs/spec.md` US-P5 AC1, §3.5 AC2, §6.1, §6.3, §6.4, §6.5, §9.1, A7, A8, §13 Q7; `docs/architecture.md` §2.2 and §15.6; `docs/plan/m4-breakdown.md` items 4 and 5; ADR-002, ADR-003, ADR-005, ADR-014, ADR-029 §1, §2, §5, §7, §8; ADR-030 §2 and §4.
- Stale-sentence sweep: recorded in the PR report.
- `prettier --check` run against the branch head.
