# ADR-031: Presence, away transitions, and defensive autopilot

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 4 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-014 (WebSocket ticket), ADR-029 (round states, timers, pause, §7 authorization), ADR-030 (reads away state)

Citation convention: a reference such as §3.5 cites item 5 of section 3 of the same document, and a reference such as ADR-030 §2.3 cites item 3 of section 2 of that ADR.

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
- Narrowings of the spec, all made by decision in this ADR and not by reading the spec: (1) the §6.3 autopilot list is narrowed to Dodge or hold only for M4 (§5.4); (2) autopilot declines all reactions, including opportunity attacks (§6); (3) control restore stays within 2 s of reconnect (US-P5 AC1), with control granted at authenticated-reconnect success and the clock running from socket open to that grant (§3.1); (4) a seat's reactions are auto-declined at once on confirmed `away`, where spec §6.3 auto-declines only on expiry (§6); (5) spotlight prompts go only to seats in the `connected` or `returning` state, and `disconnected`, `away`, `revoked`, and `unknown` seats are excluded from the spec A8 per-player prompt count while they are in those states, because a prompt to a seat that holds no control cannot be answered (§4.5). Where this ADR and the spec differ, this ADR governs for M4.
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
| `returning` | Authenticated (§3.5 check passed), held less than 10 s. | Yes, from reconnect success (§3.1). Control means the right to submit input, which is queued until the snapshot ack (§3.2). | No |
| `disconnected` | Socket closed. The 30 s away clock is running. | No | No |
| `away` | 30 s of accumulated disconnected time on a running server (§2.2). Excluded from round required sets. Stays in rest-vote N and counts as `no` unless its ballot was cast (§4.2). | No | No |
| `unknown` | Presence not known after a server restart (§2.6). | No | No |
| `revoked` | Seat removed by kick, ban, retirement, or departure (§2.7). Terminal for that seat. Stays in rest-vote N with its counted ballot, and can cast nothing further (§4.2). | No | No |

A seat gets control only after the re-check in §3.5 passes. Only confirmed-connected seats count toward the pause rule (§4.7).

### 2. Transitions and events

1. **Disconnect.** A confirmed disconnect moves the seat to `disconnected`. For a socket close, the 30 s away clock starts at close. For silent loss, heartbeats run every 5 s and 3 missed heartbeats detect loss at 15 s after the last heartbeat received, but the 30 s clock runs from that last heartbeat, so `away` occurs about 30 s after it (Decision item 6). `SeatDisconnected{seat, at}` is emitted only if the seat is still `disconnected` after 10 s (§2.5), so a blip leaves no event.
2. **Away.** A seat moves to `away` only from `disconnected`, after 30 s of accumulated disconnected time on a running server, and emits `SeatAway{seat, at}`. The 30 s clock starts at the socket close for a close, and at the last heartbeat for a silent loss. Time spent in `returning` is not counted: the clock is suspended while the seat is `returning`, so a seat that has been granted control by an authenticated reconnect can never lose it to `away` during its hold. A drop during the hold returns the seat to `disconnected` and the clock resumes from the time already accumulated. Only a completed 10 s hold, which makes the seat `connected`, clears the clock.
3. **Return.** A socket that passes the §3.5 check moves the seat to `returning`, and control is granted within 2 s (§3.1). A `disconnected` seat that returns keeps its away clock running. The clock is not reset (point 5). An `away` seat that passes the §3.5 check moves to `returning`, with control, like any other seat. The `away` state ends there, and a drop during the hold sends it back through `disconnected` as item 5 says.
4. **Hold.** A `returning` seat becomes `connected` after 10 s without a socket drop. The hold itself emits no event, and completing it clears the away clock. `SeatReconnected{seat, at, wasAway}` is emitted at the control grant (§3.1), and only when a `SeatDisconnected` or `SeatAway` was emitted for that disconnect. `wasAway` is true only when the seat was `away` at its return.
5. **Hysteresis on both edges.** The 10 s value applies to entering `disconnected` (point 1: no event before 10 s) and to leaving `returning` (point 4: `connected` only after a full 10 s hold). Its effect on the 30 s away clock, as decided by this ADR (item 2): the clock counts disconnected time only. A reconnect shorter than the 10 s hold does not restart it, and it is suspended, not reset, while the seat is `returning`. Only a completed 10 s hold clears the clock, and a later drop starts a new 30 s clock. A drop during `returning` goes back to `disconnected` and the clock resumes. A drop during `returning` always goes to `disconnected`, with the accumulated disconnected time kept. If that time is already 30 s or more, as for a seat that was `away` before its return, `away` follows at once from `disconnected`. Entering or leaving `away` never restarts the clock.
   Worked cases:
   - *Silent loss.* The last heartbeat arrives at t = 0. Loss is detected at t = 15 s, but the away clock starts at t = 0; `away` is reached at t = 30 s, not t = 45 s.
   - *Socket close.* The socket closes at t = 0. The away clock starts at close and `away` is reached at t = 30 s.
   - *Reconnect at 5 s.* Authenticated at 5 s, so the seat is `returning` and control is granted at 5 s. No `SeatDisconnected` was emitted (the seat was never `disconnected` for 10 s), so the grant emits no `SeatReconnected`. The 10 s hold runs to 15 s, when the seat becomes `connected` and the clock is cleared. No event is emitted at 15 s.
   - *Reconnect at 25 s.* Authenticated at 25 s after 25 s of disconnected time, so the seat is `returning` and control is granted at 25 s. `SeatDisconnected` was emitted at 10 s, so the grant emits `SeatReconnected{seat, at, wasAway: false}`. The away clock is suspended at 25 s. At t = 30 s the seat is still `returning`, so it does not become `away` and keeps control. If it drops at 28 s of hold it returns to `disconnected` with 25 s accumulated, and `away` follows after 5 s more disconnected time. If it completes the hold at 35 s, it is `connected` and the clock is cleared.
   - *Away seat drops during its hold.* A seat that was `away` returns and becomes `returning`. It drops 4 s into the hold. It goes to `disconnected` with its accumulated time of 30 s or more kept, so it becomes `away` again at once, and control is lost.
   - *Reconnect at 15 s.* `SeatDisconnected{seat, at}` is emitted at 10 s. Authenticated at 15 s, so the seat is `returning` and control is granted at 15 s, emitting `SeatReconnected{seat, at, wasAway: false}`. The 10 s hold runs to 25 s, when the seat becomes `connected` and the clock is cleared before it reaches 30 s, so no `SeatAway` is emitted.
6. **Unknown.** At server restart every seat moves to `unknown`, and no away clock runs. A `connected` or `returning` seat whose heartbeat is lost is a confirmed disconnect (point 1) and moves to `disconnected`, not `unknown`. A seat leaves `unknown` only through point 3. `unknown` never becomes `away` by time, so autopilot never acts on it (§5.1). An `unknown` seat counts as not connected, and the round completes at its timer.
7. **Revoked.** Removal moves the seat to `revoked` at once, with no clock. It emits `SeatRevoked{seat, at, cause}`, where `cause` is `kick`, `ban`, `retired`, or `departed`. Revocation removes control and chat only. A revoked seat stays in rest-vote N with its counted ballot, or counts as `no` if it had not cast, and can cast nothing further (§4.2). A revoked seat cannot return in M4. Re-entry needs a new seat authorization: the host approves the joiner as a new seat under Seat claim and entry, item 2 (spec §6.5). A ban is keyed to the account and checked at join request, before host approval. A banned account gets no seat and no presence record. A kicked account may request again and needs host approval. Reclaim (Seat claim and entry, item 1) applies only to `away` seats.
8. **Event rate limit.** At most one presence event per seat per 10 s. A transition inside that window is merged into the next event, and the log records the state that holds at the window's end. State changes apply immediately and only event emission is coalesced. The snapshot always holds the current state. `SeatRevoked` and `SeatTakenOver` are exempt from the window and are emitted at once, because a revoked seat must lose control and a takeover must be visible when it happens.
9. **Retention.** Presence events (`SeatDisconnected`, `SeatReconnected`, `SeatRevoked`, `AutopilotActed`, and the other presence events in §2) are in the ADR-017 class **Gameplay data**. ADR-017 §Data classes reads, exactly: "Gameplay data | events, snapshots, registry | live while session active; `archived` after 14 days idle; deleted 90 days after archive unless claimed (spec A4)". Presence events take the same retention as the vote events in ADR-030 §7. They are live while the session is active, archived after 14 days idle, and deleted 90 days after archive unless claimed. On account deletion, the seat identity in each presence event is scrubbed and its timestamps are kept. Sessions are handled by the same rule as ADR-030 §7.2: a session where the deleted account is only a seat is redacted per ADR-017 ("Sessions where the deleted account is only a seat are redacted, not purged"). In a shared session, presence events keep every other seat's identity and only the deleted seat's identity is scrubbed. Vote events follow ADR-030 §7.2, which scrubs a whole vote's ballot events, not only the deleted seat's, because the other ballots together with the outcome could reveal the deleted seat's choice.

Event types declared as additions to the v0.2 event list in architecture §15.6: `SeatDisconnected`, `SeatAway`, `SeatReconnected`, `SeatRevoked`, `SeatTakenOver`, `AutopilotActed`. This ADR declares them. Neither `docs/architecture.md` nor ADR-022 is edited. All are appended to the log (ADR-003) and visible to all seats.

### 3. Control restore, state restore, and re-check

1. **Control restore: 2 s.** This is the spec US-P5 AC1 clock. Clock start: socket open for the reconnect. Clock end: the control grant, which is made at authenticated-reconnect success, meaning the socket is authenticated and the §3.5 check has passed. After a `SeatDisconnected` or `SeatAway`, the grant is recorded by `SeatReconnected` (§2.4). A blip with no such event has no event at the grant, and the clock ends there. The 2 s target is for control granted at authentication, not for an actionable restored session. The seat remains read-only until the snapshot ack (up to 3 s); actions wait for that ack. The control clock ends at the grant, not at the state ack in item 2. This covers input rights only.
2. **Full state restore: 3 s.** Clock start: the snapshot request, sent at reconnect success. Clock end: the snapshot ack, the point at which the client holds full state (§9.1). State sync grants no control; control ends at the grant in item 1. Until the ack, the client is read-only and submits no action. Actions wait for the ack; input received before the ack is queued and processed after it (item 4).
3. **Both targets stand.** They measure different things. Neither replaces the other, and this ADR changes no spec number.
4. **Input during restore.** Input received before the snapshot ack is queued and processed after it, in receipt order (ADR-029 §1).
5. **Re-check on every return.** Before a return gets control, run the control check: the ticket is valid and not revoked (ADR-014); the seat is still seated and not retired; the ticket's account is the seat's owning account; and, for every socket that takes control of the seat, including the owner's first return after disconnect or silence, the current resume token matches (§3.6) or the host has approved the claim under §3.6. A valid ticket without the current token, and without host approval, is refused at the grant. If the check fails, the socket is closed with an auth error. No `SeatReconnected` is emitted, control is not granted, and the presence state does not change. Mute is not part of this check. A muted seat regains game control on return and stays muted for chat until the host unmutes. The mute persists across reconnect (Decision item 7). The ADR-029 §7 chat gate still applies the mute test to chat sends.
6. **Resume token and socket claim.** Every socket that takes control of a seat, including the owner's first return after disconnect or silence, must present that seat's current resume token. A valid ticket alone is never sufficient. The token is 128-bit random, generated server-side, stored server-side only as a hash, delivered over the existing authenticated socket (never a URL), and expires when the table session ends or the seat is revoked. It is rotated on every authenticated connect; the owner's client presents the current token. A lost token (including a new device or cleared storage) requires host approval. The host has 60 s to approve a pending claim; otherwise it is refused and the seat stays unclaimed, and the player may request again. Host approval applies only when the seat's socket is closed or declared lost; it cannot displace a healthy first socket. A player moving devices closes the old socket first. A host removing a player uses kick/revocation (§2.7), not approval.

   A healthy first socket means its heartbeat is fresh (§2.1). It is never displaced by any socket, host approval, or token. For a claim after close or declared loss, a current token authenticates the owner; without it, host approval is required. The new socket runs the §3.5 check. Control is granted at authentication (§3.1), then the client remains read-only until snapshot ack (up to 3 s, §3.2); actions wait for that ack. A seat has at most one controlling socket. A takeover emits `SeatTakenOver{seat, at}`. The transport ADR MUST limit socket authentication attempts to at most 5 per minute per seat and MUST impose per-IP and per-account limits.

   Verification: a leaked ticket alone cannot return or take a seat after the owner's socket goes silent, and a valid ticket without the current token is refused at the grant (§3.5); the owner's healthy token-bearing reconnect is accepted. A host-approved claim cannot displace a healthy first socket. A lost token requires host approval within 60 s or the claim is refused and the seat remains unclaimed.

### 4. Effect of presence on rounds and combat

1. **Required sets.** For round completion only, `away` and `revoked` seats are excluded from the required set of any round. This is the only rule that excludes them in rounds. It is not the rest-vote N rule in item 2: N is for rest votes only and does not apply to rounds. `disconnected`, `returning`, and `unknown` seats stay in the round required set, so a 30 s blip does not change a round.
2. **Rest-vote N (ADR-030 §2.3).** N is fixed at vote open to every seated, non-retired seat regardless of presence, and never changes after open for any cause. An `away` seat stays in N. If it had cast, its ballot is kept and counts. If it had not cast, it is fixed as `no`. A seat that is `revoked` (kick, ban, retirement, or departure) stays in N and keeps its counted ballot, or counts as `no` if it had not cast. It can cast nothing further. Revocation removes control and chat only; it never changes N or the result. `disconnected`, `returning`, `unknown`, and `away` seats are never removed from N by going away. Presence never lowers the pass bar.
   - An `away` seat cannot cast. A cast needs control (§3.1).
3. **Submissions kept.** A submission accepted before the seat went away is kept. A queued submission is kept and promoted to `accepted` at the next round open, in `receiptSeq` order (ADR-029 §4, Promotion). Its away state does not change that.
4. **No edits without control.** A seat without control cannot edit or withdraw. A `returning` seat has control from reconnect success (§3.1). `disconnected` and `unknown` seats do not.
5. **Exploration.** An away PC does not submit an action. The party's PC follows the party. Spotlight prompts (A8) go only to seats in the `connected` or `returning` state, because those seats hold control and can answer. `disconnected`, `away`, `revoked`, and `unknown` seats are excluded.
6. **Combat.** A confirmed `away` PC's turn is taken by autopilot (§5). A committed action stays committed when the seat returns, unless the returning seat replaces it (item 8).
7. **Zero confirmed-connected seats.** When no seat is `connected`, the table moves from `active` to `paused` (architecture §2.2). `returning`, `disconnected`, `away`, `unknown`, and `revoked` do not count. The table records the cause of every pause: `host` for a pause the host requested, `no-connected-seats` for this rule. Only a pause whose sole cause is `no-connected-seats` auto-resumes to `active`, when at least one seat reaches `connected`, which is after its 10 s hold (§2.4). Resume needs no host action in that case, as architecture §2.2 (`paused --> active: host resume / reconnect`) allows. A pause with cause `host` ends only when the host resumes; a seat reaching `connected` never lifts it, and if the host pauses while no seat is connected, the cause stays `host` until the host resumes. Pause freezes the round timer under ADR-029 §5, but does not freeze presence clocks or the reconnect hold; those continue so a returning seat can become confirmed-connected and auto-resume the table.
8. **Replacement of autopilot commands.** Until the turn resolves, a returning seat's command replaces an autopilot-committed command. The replacement is a normal player command. It counts against the ADR-029 §8 per-seat budget and is applied in receipt order. The log keeps the `AutopilotActed` event followed by the seat's command.
9. **Host.** When the host is `away`, the table keeps running and nothing transfers automatically. An `away` or `revoked` host is ineligible as tie-breaker. The tie fails with reason `tie-failed`: at once when the host seat is revoked, and at expiry when it is away (ADR-030 §3.4). There is no host reassignment in M4, so a revoked host's host actions are unavailable. Host actions, including pause, use the host's recorded presence state as it stands.

### 5. Defensive autopilot

1. **Scope.** Autopilot acts only for a confirmed `away` PC, during combat, on that PC's turn (A7). It never acts for `unknown`, `disconnected`, `returning`, or `revoked` seats. It never acts in exploration, never casts a rest vote, never submits a non-defensive action, and never speaks.
2. **Trigger.** A deliberate away gains nothing beyond Dodge being taken for it (harmless, A7), no reroll, and no reaction bypass. A seat that goes away on purpose gets no extra turn, action, or vote weight; its ballot and its autopilot turn follow §4.2 and this section exactly as an accidental away does. It acts when the away PC's combat turn begins, and only if the seat is confirmed `away` at that point. If the seat becomes `away` during its own turn, that turn is not replaced mid-turn. It resolves by the 90 s timer as Dodge (spec US-B2 AC2). Autopilot acts for the seat from its next turn prompt, once it is confirmed `away`.
3. **Engine function.** `autopilot(state, seat) -> command`. It is a pure function of the Room state and the seat. It reads only engine state: positions, HP, turn order, conditions, and concentration. It never reads chat, player text, or LLM output. It uses no LLM and no judge call.
4. **Policy: Dodge or hold only.** Spec §6.3 gives the defensive autopilot list: Dodge, move to cover within speed, use a healing potion below 25% HP, and never spend consumables otherwise, initiate risky actions, or move into hazards. This ADR narrows that list for M4, as decided here: autopilot takes no movement, so no move to cover, no opportunity attack, and no consumable (including the healing potion), spell, or hazard action. The narrowing is an explicit decision of this ADR, not a reading of the spec.
   1. Dodge is the default and only action.
   2. Dodge is unavailable when the engine rejects the Dodge command for that turn, meaning no action is available this turn. Then hold: end the turn with no action.
   3. Reactions are declined (§6).
5. **Concentration.** Dodge does not break concentration. Autopilot never starts, ends, or changes a concentration effect.
6. **Output.** The command goes through the same rules engine path as a player command and emits `AutopilotActed{seat, action, reason, consumable}`. `action` is `dodge` or `hold`. `reason` is a fixed enum with one value, `away-at-turn-start`. `consumable` is always `none`, because M4 autopilot uses no consumables (item 4). There is no mid-turn autopilot action (§5.2), so no mid-turn reason exists. A turn that the 90 s timer resolves as Dodge (spec US-B2 AC2) is not an autopilot action: it is the engine's turn-timeout default, recorded as that default action under spec §3.5 and US-B2 AC2. This ADR adds no event for it, and `AutopilotActed` is not emitted for it.
7. **No speaking.** Autopilot never produces chat, narration, or DM-facing text.
8. **Unknown seats.** Autopilot does not act for an `unknown` seat. An `unknown` seat counts as not connected, and the round completes at its timer. The 90 s turn timer resolves its turn as Dodge (spec §3.5). If no seat is connected, the table is paused (§4.7).

### 6. Reaction window

Reactions use the 15 s window in spec §6.3. When the reacting seat is confirmed `away`, `revoked`, or `unknown`, its reactions are auto-declined at once. This narrows spec §6.3, which auto-declines only on expiry; the early decline is this ADR's decision. A `returning` seat keeps its window. Defensive autopilot declines every reaction, so an away seat never takes an opportunity attack or any other reaction. This is a narrowing of the 15 s auto-decline in spec §6.3, and it is this ADR's decision, not a reading of the spec.

### 7. Timer and threshold defaults

This section sets the "120 s round" default that ADR-029 §8 refers to. It was not set anywhere before this ADR.

| Timer or threshold | Default | Source | Notes |
|---|---|---|---|
| Exploration round | 120 s | spec §6.1, ADR-005 | Default. Host-configurable, "off" allowed, Resolve now control. |
| Combat turn (party) | 90 s | spec US-B2 AC2, ADR-005 | Default. Host-configurable (spec line 575); off for solo. Expiry resolves as Dodge. Min and max bounds are not set in the spec and are decided in M4 item 3 (host controls). |
| Rest vote | 120 s | ADR-030 §4 | Fixed for M4. |
| Reaction window | 15 s | spec §6.3 | Auto-declined for `away`, `revoked`, and `unknown` seats. |
| Away threshold | 30 s | spec US-P5 AC1, §6.4 | Applies to `disconnected` seats on a running server. For close: from close; for silent loss: from last heartbeat (§2.1). |
| Hysteresis on both edges | 10 s | §2.5 | Starting value, tunable by amendment. |
| Presence event window | 10 s | §2.8 | Coalesces presence events. |
| Heartbeat interval | 5 s | §2.1, Decision item 6 | Tunable by amendment. |
| Heartbeat missed limit | 3 missed (lost at 15 s) | §2.1, Decision item 6 | Tunable by amendment. |

Pause freezes game timers except presence clocks and reconnect hold, which continue to support away transitions and automatic table resume. ADR-029 §5 covers the round timer.

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
6. **Heartbeat.** Decided by Atlas: 5 s interval; 3 missed heartbeats declare the connection lost at 15 s, which is a confirmed disconnect (§2.1). For a close, the 30 s away clock starts at close; for silent loss, it starts at the last heartbeat even though loss is detected at 15 s. The clock counts disconnected time only: it is suspended, not reset, across a reconnect shorter than the 10 s hold, and only a completed hold clears it. Values are tunable by amendment.
7. **Muted seat on return.** Decided by Atlas: a muted seat regains game control on return but stays muted for chat until the host unmutes. Mute persists across reconnect (§3.5). Mute does not cover free-text game actions: those pass the action-input gate and are moderated by it like any player input, and a host who needs to stop a player uses kick (revocation, §2.7). ADR-029 §7 is not edited here. Interim rule, in force with this ADR: the ADR-029 §7 chat gate keeps the mute test for chat sends, and for control the §3.5 check governs, which has no mute test. Where ADR-029 §7's wording reads as barring control on mute, this ADR governs control until the amendment is merged. The amendment that makes the ADR-029 §7 wording match is tracked in new ADR-032 (Workboard card 8195eb48).
8. **Reclaim is owner-only; drop-in stays in M4 scope.** Decided by Atlas, per spec §6.4 and §6.5.
9. **A returning seat may replace an autopilot command until the turn resolves.** Decided by Atlas.
10. **Mid-turn away and the reason enum.** Follows Atlas's decision that a mid-turn away is not replaced mid-turn. The turn resolves by timer as Dodge, and autopilot acts from the seat's next turn prompt. This leaves `reason` with one value, `away-at-turn-start`. Atlas confirmed the enum is closed. It can be extended only by amendment to this ADR.
11. **Hysteresis clock.** Decided by this ADR: a seat becomes `away` only from `disconnected`, after 30 s of accumulated disconnected time. The clock is suspended while the seat is `returning`, a reconnect shorter than the 10 s hold does not restart it, and only a completed hold clears it. A later drop starts a new 30 s clock.

## Verification

- Docs-only change: one file, `docs/adr/031-presence-away-autopilot.md`. No existing ADR and no `docs/architecture.md` change. No code is written.
- Citations checked against `docs/spec.md` US-P5 AC1, US-B2 AC2, §6.1, §6.3 (autopilot list, 15 s window), §6.4, §6.5, §9.1, A7, A8, §13 Q7, and the turn-timer consistency line in §15 (both timers host-configurable); `docs/architecture.md` §2.2 and §15.6; `docs/plan/m4-breakdown.md` items 4 and 5; ADR-002, ADR-003, ADR-005, ADR-014, ADR-029 §1 (barrier and input queueing), §2, §4 (promotion at next round open), §5, §7 (re-check and gate), §8 (per-seat budget and 120 s round); ADR-030 §2.3 (every seat stays in N for every cause; counted ballot kept, or uncast counts as no), §3.4 (host tie fails when revoked or away), §5.1 (cast re-check). New event types are declared as additions to the v0.2 list in architecture §15.6; neither `docs/architecture.md` nor ADR-022 is edited.
- Pause causes: a host pause is not lifted when a seat reaches `connected` (only the host resumes it); a `no-connected-seats` pause resumes when one seat reaches `connected` after its 10 s hold; a host pause made while no seat is connected stays paused until the host resumes (§4.7).
- Socket authentication limit: a sixth authentication attempt for the same seat within one minute is refused; per-IP and per-account limits are set by the transport ADR (§3.6).
- Reconnect at 25 s: the seat is `returning` at 30 s, keeps control, and does not become `away` (§2.2, §2.5).
- Presence events are visible to all seats by design (the spec drop-out and spotlight rules need it); timestamps remain after account deletion with the seat identity scrubbed (§2.9). A deliberate away gives only a Dodge and declined reactions, which is intended and harmless under spec A7 (§5.2).
- Run by the author before push: `pnpm exec prettier --check` and the stale-sentence sweep. The output is not attached, so the reviewers have not verified that claim.
