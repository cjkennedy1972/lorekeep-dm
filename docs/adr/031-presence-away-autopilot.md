# ADR-031: Presence, away transitions, and defensive autopilot

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 4 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-014 (WebSocket ticket), ADR-029 (round states, timers, pause, §7 authorization), ADR-030 (reads away state)

Append-only: this ADR defines presence and autopilot contracts. It does not edit ADR-001 through ADR-030 or `docs/architecture.md`. Its event types are declared as additions to the v0.2 event list in architecture §15.6, as ADR-030 does. Where ADR-005 is still Proposed, this ADR states the decision it needs and marks it as such.

## Context

- Spec §3.2 US-P5 AC1: a player disconnected for more than 30 s is marked away, and control is restored within 2 s of reconnect.
- Spec §9.1: reconnect and full state restore complete within 3 s. US-P5 measures control and §9.1 measures full state, so they are separate targets (§3).
- Spec US-B2 AC2 (§3.5): a party combat turn timer of 90 s, host-configurable; expiry resolves the turn as Dodge.
- Spec §6.1: the exploration round default is 120 s, host-configurable, with "off" allowed and a Resolve now control.
- Spec §6.3: a 15 s reaction window; a defensive autopilot list (Dodge, move to cover within speed, healing potion below 25% HP, no risky actions or hazards). This ADR narrows that list for M4 (§5.4).
- Spec §6.4: a seat drops out after 30 s and is excluded from the spotlight. Drop-in is governed by §6.4. Zero connected seats pauses the table.
- Spec §6.5: the host approves or denies late joiners.
- Spec A7: autopilot is defensive only. Spec A8: the spotlight gives every active player at least one direct prompt per 10 DM turns.
- Narrowings of the spec, all made by decision in this ADR and not by reading the spec: (1) the §6.3 autopilot list is narrowed to Dodge or hold only for M4 (§5.4); (2) autopilot declines all reactions, including opportunity attacks (§6); (3) control restore stays within 2 s of reconnect (US-P5 AC1) but is timed from authenticated reconnect to the control grant (§3.1). Where this ADR and the spec differ, this ADR governs for M4.
- Spec §13 Q7 asks whether autopilot may take part in votes. Chris's delegate decided it does not (§5.1). Q7 stays open for Chris to close.
- Architecture §2.2: active → paused on host pause or zero confirmed-connected seats.
- ADR-029 §7: every chat send re-checks the socket's ticket, the seat, and its retirement and mute state.
- ADR-005 (Proposed): a 120 s party round default; a 90 s combat turn timer; away seats excluded from quorum (superseded for rest-vote N by §4.2); autopilot as a pure engine function.
- ADR-029 §8 refers to a "120 s round" that is not set anywhere. §7 below sets it.
- ADR-030 defines the rest vote and reads away state from this ADR.

## Decision

### 1. Presence states

Each seat is in exactly one presence state. Presence is engine state in the Room (ADR-002), not a client flag.

| State | Meaning | Control | Confirmed-connected |
|---|---|---|---|
| `connected` | Authenticated (§3.5 check passed) and held for 10 s (§2.4). | Yes | Yes |
| `returning` | Authenticated (§3.5 check passed), held less than 10 s. | Yes, from 2 s (§3.1) | No |
| `disconnected` | Socket closed. The 30 s away clock is running. | No | No |
| `away` | Disconnected for 30 s on a running server. Excluded from round required sets. Stays in rest-vote N and counts as `no` unless its ballot was cast (§4.2). | No | No |
| `unknown` | Presence not known after a server restart or a missed heartbeat (§2.6). | No | No |
| `revoked` | Seat removed by kick, ban, retirement, or departure (§2.7). Terminal for that seat. | No | No |

A seat gets control only after the re-check in §3.5 passes. Only confirmed-connected seats count toward the pause rule (§4.7).

### 2. Transitions and events

1. **Disconnect.** A socket close moves the seat to `disconnected` and starts the 30 s clock. `SeatDisconnected{seat, at}` is emitted only if the seat is still `disconnected` after 10 s (§2.5), so a blip leaves no event.
2. **Away.** At 30 s of continuous `disconnected` on a running server, the seat moves to `away` and emits `SeatAway{seat, at}`.
3. **Return.** A socket that passes the §3.5 check moves the seat to `returning`, and control is granted within 2 s (§3.1). A `disconnected` seat that returns stops its clock. The clock is kept, not reset (point 5). An `away` seat stays `away` until it reaches `connected`.
4. **Hold.** A `returning` seat becomes `connected` after 10 s without a socket drop. The hold itself emits no event, and completing it clears the away clock. `SeatReconnected{seat, at, wasAway}` is emitted at the control grant (§3.1), and only when a `SeatDisconnected` or `SeatAway` was emitted for that disconnect. `wasAway` is true only when the seat was `away` at its return.
5. **Hysteresis on both edges.** The 10 s value applies to entering `disconnected` (point 1: no event before 10 s) and to leaving `returning` (point 4: `connected` only after a full 10 s hold). Its effect on the 30 s clock: the clock starts at socket close, pauses while the seat is `returning`, and is cleared only by a completed hold. A drop during `returning` goes back to `disconnected`, and the clock resumes from where it paused. It is not reset. A seat that was `away` and drops during `returning` goes back to `away`. So `away` needs 30 s of disconnected time with no completed hold in between. Entering or leaving `away` never restarts the clock.
6. **Unknown.** At server restart every seat moves to `unknown`, and no away clock runs. A `connected` or `returning` seat whose heartbeat is missing past the limit (Decision item 6) moves to `unknown`. A seat leaves `unknown` only through point 3. `unknown` never becomes `away` by time, so autopilot never acts on it (§5.1).
7. **Revoked.** Removal moves the seat to `revoked` at once, with no clock. It emits `SeatRevoked{seat, at, cause}`, where `cause` is `kick`, `ban`, `retired`, or `departed`. A revoked seat returns only through a new authorization under Seat claim and entry, item 2.
8. **Event rate limit.** At most one presence event per seat per 10 s. A transition inside that window is merged into the next event, and the log records the state that holds at the window's end. State changes apply immediately and only event emission is coalesced. The snapshot always holds the current state.
9. **Retention.** Presence events (`SeatDisconnected`, `SeatReconnected`, `SeatRevoked`, `AutopilotActed`, and the other presence events in §2) are in the ADR-017 gameplay class, the same class as the vote events in ADR-030 §7. They are live while the session is active, archived after 14 days idle, and deleted 90 days after archive unless claimed.

Event types declared as additions to the v0.2 event list in architecture §15.6: `SeatDisconnected`, `SeatAway`, `SeatReconnected`, `SeatRevoked`, `SeatTakenOver`, `AutopilotActed`. This ADR declares them. Neither `docs/architecture.md` nor ADR-022 is edited. All are appended to the log (ADR-003) and visible to all seats.

### 3. Control restore, state restore, and re-check

1. **Control restore: 2 s.** Clock start: authenticated-reconnect success, meaning the socket is authenticated and the §3.5 check has passed. Clock end: the control grant. After a `SeatDisconnected` or `SeatAway`, the grant is recorded by `SeatReconnected` (§2.4). A blip with no such event has no event at the grant, and the clock ends there. The seat regains input rights within 2 s (US-P5 AC1). This covers input rights only.
2. **Full state restore: 3 s.** Clock start: the snapshot request. Clock end: the snapshot ack, the point at which the client holds full state (§9.1).
3. **Both targets stand.** They measure different things. Neither replaces the other, and this ADR changes no spec number.
4. **Input during restore.** Input received before the snapshot ack is queued and processed after it, in receipt order (ADR-029 §1).
5. **Re-check on every return.** Before a return gets control, run the ADR-029 §7 check on the socket's ticket: the ticket is valid and not revoked (ADR-014), the seat is still seated, and it is not retired or muted. The ticket's account must also be the seat's owning account. If the check fails, the socket is closed with an auth error. No `SeatReconnected` is emitted, control is not granted, and the presence state does not change. Because "not muted" is part of the check, a muted seat cannot regain control on return (Decision item 7).
6. **Takeover.** A second socket for a seat that already has an open socket runs the same check. If it passes, the new socket is acked and then the first socket is closed, so the seat never has zero sockets. Presence does not change, and no disconnect or away clock starts. If the check or the ack fails, the first socket is untouched. A seat has at most one socket at a time. A takeover emits `SeatTakenOver{seat, at}`.

### 4. Effect of presence on rounds and combat

1. **Required sets.** For round completion only (not rest-vote N, item 2), `away` and `revoked` seats are excluded from the required set of any round. `disconnected`, `returning`, and `unknown` seats stay in it, so a 30 s blip does not change a round.
2. **Rest-vote N (ADR-030 §2.3).** N is fixed when a vote opens. An `away` seat stays in N. If it had cast, its ballot is kept and counts. If it had not cast, it counts as `no`. A seat that is `revoked` by departure, retirement, kick, or ban leaves N, and its cast ballot, if any, is voided. `disconnected`, `returning`, `unknown`, and `away` seats are never removed from N by going away. Presence never lowers the pass bar.
   - An `away` seat cannot cast. A cast needs control (§3.1).
3. **Submissions kept.** A submission accepted before the seat went away is kept. A queued submission is kept and promoted to `accepted` at the next round open, in `receiptSeq` order (ADR-029 §4, Promotion). Its away state does not change that.
4. **No edits without control.** A seat without control cannot edit or withdraw. A `returning` seat has control from 2 s. `disconnected` and `unknown` seats do not.
5. **Exploration.** An away PC does not submit an action. The party's PC follows the party. Spotlight prompts (A8) go only to connected seats. `away`, `revoked`, and `unknown` seats are excluded.
6. **Combat.** A confirmed `away` PC's turn is taken by autopilot (§5). A committed action stays committed when the seat returns, unless the returning seat replaces it (item 8).
7. **Zero confirmed-connected seats.** When no seat is `connected`, the table moves from `active` to `paused` (architecture §2.2). `returning`, `disconnected`, `away`, `unknown`, and `revoked` do not count. Pause freezes all timers (ADR-029 §5). Resume follows ADR-029 §5.
8. **Replacement of autopilot commands.** Until the turn resolves, a returning seat's command replaces an autopilot-committed command. The replacement is a normal player command. It counts against the ADR-029 §8 per-seat budget and is applied in receipt order. The log keeps the `AutopilotActed` event followed by the seat's command.
9. **Host.** When the host is `away`, the table keeps running and nothing transfers automatically. An `away` or `revoked` host is ineligible as tie-breaker. A `revoked` host has also left N, so under ADR-030 §3.4 a tie with no eligible host fails as `tie-failed`. When the host is `revoked`, host actions are unavailable until a manual host reassignment outside this ADR. Host actions, including pause, use the host's recorded presence state as it stands.

### 5. Defensive autopilot

1. **Scope.** Autopilot acts only for a confirmed `away` PC, during combat, on that PC's turn (A7). It never acts for `unknown`, `disconnected`, `returning`, or `revoked` seats. It never acts in exploration, never casts a rest vote, never submits a non-defensive action, and never speaks.
2. **Trigger.** A deliberate away gains nothing. A seat that goes away on purpose gets no extra turn, action, or vote weight; its ballot and its autopilot turn follow §4.2 and this section exactly as an accidental away does. It acts when the away PC's combat turn begins, and only if the seat is confirmed `away` at that point. If the seat becomes `away` during its own turn, that turn is not replaced mid-turn. It resolves by the 90 s timer as Dodge (spec US-B2 AC2). Autopilot acts for the seat from its next turn prompt, once it is confirmed `away`.
3. **Engine function.** `autopilot(state, seat) -> command`. It is a pure function of the Room state and the seat. It reads only engine state: positions, HP, turn order, conditions, and concentration. It never reads chat, player text, or LLM output. It uses no LLM and no judge call.
4. **Policy: Dodge or hold only.** Spec §6.3 gives the defensive autopilot list: Dodge, move to cover within speed, use a healing potion below 25% HP, and never spend consumables otherwise, initiate risky actions, or move into hazards. This ADR narrows that list for M4, as decided here: autopilot takes no movement, so no move to cover, no opportunity attack, and no consumable (including the healing potion), spell, or hazard action. The narrowing is an explicit decision of this ADR, not a reading of the spec.
   1. Dodge is the default and only action.
   2. If Dodge cannot be taken, hold: end the turn with no action.
   3. Reactions are declined (§6).
5. **Concentration.** Dodge does not break concentration. Autopilot never starts, ends, or changes a concentration effect.
6. **Output.** The command goes through the same rules engine path as a player command and emits `AutopilotActed{seat, action, reason}`. `action` is `dodge` or `hold`. `reason` is a fixed enum with one value, `away-at-turn-start`. There is no mid-turn autopilot action (§5.2), so no mid-turn reason exists. Consumable use is recorded explicitly: the event carries `consumable: none` on every `AutopilotActed`, because M4 autopilot uses no consumables (item 4).
7. **No speaking.** Autopilot never produces chat, narration, or DM-facing text.
8. **Unknown seats.** Autopilot does not act for an `unknown` seat. The 90 s turn timer resolves its turn as Dodge (spec §3.5). If no seat is connected, the table is paused (§4.7).

### 6. Reaction window

Reactions use the 15 s window in spec §6.3. When the reacting seat is `away`, `revoked`, or `unknown`, the window is auto-declined at once. A `returning` seat keeps its window. Defensive autopilot declines every reaction, so an away seat never takes an opportunity attack or any other reaction. This is consistent with the 15 s auto-decline in spec §6.3, and it is this ADR's decision, not a reading of the spec.

### 7. Timer and threshold defaults

This section sets the "120 s round" default that ADR-029 §8 refers to. It was not set anywhere before this ADR.

| Timer or threshold | Default | Source | Notes |
|---|---|---|---|
| Exploration round | 120 s | spec §6.1, ADR-005 | Default. Host-configurable, "off" allowed, Resolve now control. |
| Combat turn (party) | 90 s | spec US-B2 AC2, ADR-005 | Default. Host-configurable (spec line 575); off for solo. Expiry resolves as Dodge. Min and max bounds are not set in the spec and are decided in M4 item 3 (host controls). |
| Rest vote | 120 s | ADR-030 §4 | Fixed for M4. |
| Reaction window | 15 s | spec §6.3 | Auto-declined for `away`, `revoked`, and `unknown` seats. |
| Away threshold | 30 s | spec US-P5 AC1, §6.4 | Applies to `disconnected` seats on a running server. |
| Hysteresis on both edges | 10 s | §2.5 | Starting value, tunable by amendment. |
| Presence event window | 10 s | §2.8 | Coalesces presence events. |
| Heartbeat missed limit | Not set | §2.6 | Decision item 6. |

Pause freezes every timer in this table (ADR-029 §5).

## Seat claim and entry

1. **Reclaim.** Only the owning account can reclaim its `away` seat. The return passes the §3.5 check, including the owner match. Another account cannot claim the seat. If the owner does not return, the host can retire the seat. That moves it to `revoked` with cause `retired` (spec §6.4).
2. **New seats.** A new seat exists only after its own authorization: the host approves the joiner (spec §6.5). On approval and snapshot ack, the seat starts `returning` and becomes `connected` after 10 s, like any return. A denied joiner gets no seat and no presence.
3. **Drop-in.** Drop-in placement, the scene-boundary rule, and the initiative rule are spec §6.4 and are M4 scope. This ADR governs presence only and does not change them.

## Alternatives considered

- **Auto-kick after 30 s.** Rejected: the spec defines away and drop-out, not removal. Removal needs a separate ADR.
- **Autopilot submits exploration actions.** Rejected: exploration choices are the player's. A defensive policy has no good default there (A7).
- **Autopilot votes on rest.** Rejected: autopilot never casts a vote (§5.1). Away seats stay in N and count as `no` until they cast (§4.2).
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
3. **Q7, autopilot and votes.** Decided by Chris's delegate: autopilot never votes or submits a non-defensive action, and away seats stay in the rest-vote N and count as `no` until they cast. Spec §13 Q7 remains open for Chris to close.
4. **Host away and host revoked have no automatic transfer.** Recommendation: accept, and track host reassignment as a separate ADR.
5. **Autopilot is Dodge or hold only.** Decided by Atlas for M4: no movement, no cover moves, no opportunity attacks, no consumables.
6. **Heartbeat interval and missed-heartbeat limit.** Not set in ADR-029 or any transport ADR, and needed before M4 item 4 can be built. Recommendation: set both in the transport ADR. This ADR names only the condition.
7. **Muted seat on return.** The ADR-029 §7 check includes "not muted", so a muted seat cannot regain control on return (§3.5). Mute is a chat restriction in the spec. Atlas to confirm this literal reading, or to split the check so mute blocks chat only.
8. **Reclaim is owner-only; drop-in stays in M4 scope.** Decided by Atlas, per spec §6.4 and §6.5.
9. **A returning seat may replace an autopilot command until the turn resolves.** Decided by Atlas.
10. **Mid-turn away and the reason enum.** Follows Atlas's decision that a mid-turn away is not replaced mid-turn. The turn resolves by timer as Dodge, and autopilot acts from the seat's next turn prompt. This leaves `reason` with one value, `away-at-turn-start`. Atlas to confirm the one-value enum.
11. **Hysteresis clock.** A completed 10 s hold clears the away clock. An interrupted hold pauses the clock and does not reset it, so `away` means 30 s of disconnected time since the last completed hold, not 30 s of unbroken socket closure. Atlas to confirm this reading.

## Verification

- Docs-only change: one file, `docs/adr/031-presence-away-autopilot.md`. No existing ADR and no `docs/architecture.md` change. No code is written.
- Citations checked against `docs/spec.md` US-P5 AC1, US-B2 AC2, §6.1, §6.3 (autopilot list, 15 s window), §6.4, §6.5, §9.1, A7, A8, §13 Q7, and the turn-timer consistency line in §15 (both timers host-configurable); `docs/architecture.md` §2.2 and §15.6; `docs/plan/m4-breakdown.md` items 4 and 5; ADR-002, ADR-003, ADR-005, ADR-014, ADR-029 §1 (barrier and input queueing), §2, §4 (promotion at next round open), §5, §7 (re-check and gate), §8 (per-seat budget and 120 s round); ADR-030 §2.3 (away leaves N, ballot kept), §3.4 (host tie-break, tie-failed), §5.1 (cast re-check). New event types are declared as additions to the v0.2 list in architecture §15.6; neither `docs/architecture.md` nor ADR-022 is edited.
- Stale-sentence sweep: recorded in the PR report.
- `prettier --check` run against the branch head.
