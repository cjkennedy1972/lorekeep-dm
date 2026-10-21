# ADR-030: Rest vote and party quorum

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 5 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-017, ADR-022, ADR-029 (round states, timers, pause, judge budgets, OOC), ADR-031 (away state)

Append-only: this ADR defines the rest vote. It does not edit ADR-001 through ADR-029. It fills the `call_for_rest` row that ADR-022 §2 deferred to M4. It adds four event types, listed in §6.1. It adds two error codes, listed in §1. ADR-022 is not edited.

## Context

- ADR-022 §2 defers `call_for_rest` to M4 with the reason "opens a party vote; solo has no quorum". It gives no schema, no lifecycle, no eligible-voter rule, and no tie rule.
- Spec §3.6 AC2: rest requires party consensus in multiplayer (majority vote, host tiebreak). The spec gives no timer for a vote.
- Architecture §2.2 has `exploration → rest` on "party vote passes" and `rest → exploration` on "rest resolved".
- Architecture §3.2 gives `call_for_rest(type)` as "opens a party vote" with "Engine applies rest on pass".
- M4 item 5 requires that a failed or expired vote changes no rest state, that the engine alone applies SRD rest effects, and that the vote and its result persist and are visible to all players.
- ADR-029 §2 defines round states and §5 defines pause and timers. ADR-029 §8 sets the per-seat mutation budget and judge budgets. ADR-029 §11 keeps OOC content out of DM prompts.
- ADR-017 §Data classes puts events and snapshots in the gameplay class. ADR-022 §4.2 defines the fallback turns.

## Decision

### 1. Opening a vote

1. **Trigger.** In M4, only the DM opens a vote, by calling `call_for_rest`. Players cannot open a vote (see Decisions needed).
2. **Arguments.** `{type: "short" | "long"}`. Any other value is rejected and no vote opens.
3. **Timing.** The vote opens when the DM turn that called the tool commits. It does not open mid-turn, so the T2 ordering in ADR-022 holds and the Room's single writer (ADR-002) applies the change.
4. **Fallback turns never open a vote.** A turn that ADR-022 §4.2 resolves through a fallback cannot call `call_for_rest`. The fallback cannot open a vote, even if the DM's output contained the call.
5. **Idempotent on turnId.** The open is keyed by the committing turn's `turnId`. A replayed or retried commit for the same turn does not open a second vote.
6. **Preconditions.** The table is `active` and not paused (ADR-029 §5). No round is `open`, `closing`, or `resolving`. No other vote is open. The table is in exploration, not combat (architecture §2.2). If a precondition fails, no vote opens and the DM receives `rest-not-allowed`.
7. **Rate limits on opening.** At most one vote may open per 10 min per table, measured from the close of the previous vote, whatever its outcome. At most 6 votes may be opened per session. If either limit binds, no vote opens and the DM receives `rest-not-allowed` with reason `cooldown` or `session-limit`.
8. **No overlap.** A vote and a round never run at once. A round cannot open while a vote is open, and a vote cannot open while a round is open. A vote therefore delays a round by at most its timer length (§4).
9. **Solo.** Solo has no vote. Solo rest stays a client command, `POST /session/:id/rest` (ADR-022 §2), and this ADR does not change it.

**Error codes added by this ADR** (ADR-022 §2.4 catalogue):
- `rest-not-allowed`, with a `reason` of `precondition`, `cooldown`, or `session-limit`.
- `ballot-not-allowed`, returned when a cast fails the re-check in §5.

### 2. Eligible voters and the denominator

1. **Eligible set fixed at open.** The eligible set is the seated, non-retired, non-away, non-muted seats at open. It cannot grow after open. A seat that joins after open is not eligible for that vote.
2. **Denominator D.** D is the eligible seats that are currently not `away` and not retired. An `away` seat leaves D at the moment it goes away (ADR-031 §4.1a). Its cast ballot is kept. It cannot cast or change a ballot while `away`, and if it returns before close its ballot still counts.
3. **A retired seat** leaves D and its ballot is discarded.
4. **Non-cast seats** count as `no` for the pass test at close. They do not count as abstentions.
5. **Vote count is yes and no only.** There is no abstain option.

### 3. Pass, tie, and host break

1. **Pass test.** The vote passes when yes is more than D / 2.
2. **Tie at expiry is failed.** At the deadline, a vote where yes equals no (with non-cast seats counted as no) fails with reason `tie-failed`. No host action applies at expiry.
3. **Tie before expiry: host window.** A tie can exist before the deadline only when every seat in D has cast. The host's own ballot counts once, as a normal vote. Then the host gets one separate tie-break action, a choice of `yes` or `no`, within the remaining vote window.
4. **Host eligibility at tie-break.** The tie-break needs the host to be in D and to have cast a ballot. If the host is not in D when the tie appears, the vote fails at once with reason `tie-failed`.
5. **Host tie-break outcome.** The host's choice is final. `yes` passes the vote with reason `host-tiebreak`. `no` fails it with reason `host-tiebreak`.
6. **No host action by expiry** fails the vote with reason `tie-failed` (see §4.6).
7. **The tie-break action is a cast.** It passes the same re-check as §5, uses the key `(voteId, hostSeat, "tiebreak")`, and counts toward the mutation budget.

### 4. Timing and closing

1. **Timer.** The vote timer is 120 s. It is fixed for M4 and is not host-configurable. It is separate from the exploration round timer in spec §6.1, which the host can change.
2. **Deadline is wall-clock.** At open the engine stores `deadlineAt` as a UTC timestamp. A monotonic clock is not used, because it does not survive a restart.
3. **Pause.** On pause the engine stores the remaining milliseconds. On resume it writes a new `deadlineAt` from the remaining milliseconds. Votes are rejected while paused, as ADR-029 §5 requires for submissions.
4. **Early pass.** The vote closes as passed as soon as yes is more than D / 2 (reason `majority`).
5. **Early fail.** The vote closes as failed as soon as yes plus the number of seats in D that have not cast is at most D / 2 (reason `no-majority`).
6. **Expiry.** At `deadlineAt`, the vote closes. If yes is more than D / 2 it passes (reason `majority`). If yes equals no, it fails with reason `tie-failed` (§3.2 and §3.6). Otherwise it fails with reason `expired`.
7. **All cast.** When every seat in D has cast and the result is not a tie, the vote closes at once with reason `majority` or `no-majority`. A tie goes to §3.3.
8. **Reasons.** `RestVoteClosed` records one of `majority`, `no-majority`, `host-tiebreak`, `tie-failed`, `expired`, or `cancelled`.
9. **Cooldown.** The close of any vote, whatever its outcome, starts the 10 min table cooldown in §1.7.

### 5. Casting ballots

1. **Re-check at cast.** Every cast re-checks, at cast time: the seat's ticket is valid, the seat is not revoked, and the seat is eligible (not muted, not retired, not away). A failed check returns `ballot-not-allowed` and records nothing.
2. **Idempotency key.** Each cast carries the key `(voteId, seat)`. A replayed cast with the same key returns the stored result and records nothing new.
3. **One ballot per seat, first cast wins.** A second, different ballot from a seat is rejected. There is no change after a cast.
4. **Votes skip the chat gate and judge calls.** A ballot is an enum, so it makes no judge call and uses no judge budget (ADR-029 §8). It counts toward the per-seat mutation budget of 6 per 60 s (ADR-029 §8).
5. **Late casts** after close are rejected with `vote-closed`.

### 6. Effects and persistence

1. **Events.** The vote adds four event types, listed here and not added to the ADR-022 §7 list: `RestVoteOpened{voteId, type, eligibleSeats, deadlineAt, openedByTurnId}`, `RestVoteCast{voteId, seat, choice}`, and `RestVoteClosed{voteId, outcome, reason, yes, no}`. A passed vote also emits `RestApplied{voteId, type, effects}`.
2. **Engine applies rest.** On a pass, the rules engine computes and applies the SRD rest effects in the same serial mailbox step that closes the vote (ADR-002, ADR-022 §3). The DM never writes rest effects.
3. **Rest state is transient.** The architecture §2.2 `rest` state exists only inside that mailbox step, so the Room returns to `exploration` in the same step that applies the effects.
4. **Visibility before close.** Clients see that a vote is open, its type, and its `deadlineAt`. Clients see that a seat has cast, but never the choice. The `RestVoteCast` broadcast omits `choice` until close.
5. **Visibility at close.** `RestVoteClosed` carries the yes and no tally, the outcome, and the reason. Spec §3.6 requires the result to be visible, and this rule satisfies it.
6. **DM prompt exclusion.** `RestVoteCast` events are excluded from the DM prompt allowlist. ADR-029 §11 keeps OOC content out of DM prompts; this ADR applies the same kind of exclusion to ballot choices. The DM sees only the close outcome, through `RestVoteClosed`.
7. **Persistence.** The events go to the append-only log (ADR-003). A reconnecting client gets an open vote from snapshot plus replay, with choices omitted as in §6.4.
8. **Rewind.** If a `TurnReverted` removes the turn that opened a vote, the vote closes as `cancelled` and applies nothing. If the reverted turn's rest effects were applied, the restored snapshot undoes them (ADR-003).

### 7. Retention and account deletion

1. **Class.** Vote events (`RestVoteOpened`, `RestVoteCast`, `RestVoteClosed`, `RestApplied`) are in the ADR-017 gameplay class, the same class as events and snapshots. They are live while the session is active, archived after 14 days idle, and deleted 90 days after archive unless claimed.
2. **Account deletion.** When a seat's account is deleted, the seat reference in vote events is scrubbed by the existing deletion behaviour in ADR-017 (seat-only sessions are redacted).
3. **Anonymised tally.** After scrubbing, a ballot keeps only its `choice`, with no seat. The `RestVoteClosed` tally is unchanged.

### 8. Failed or expired vote

A failed, expired, cancelled, or `tie-failed` vote emits `RestVoteClosed` only. It changes no rest state and applies no effects (M4 item 5). The DM sees the outcome in its next turn context and may narrate it. The 10 min cooldown in §1.7 still applies.

## Alternatives considered

- **Simple majority of ballots cast, abstentions excluded.** Rejected: two of six seats could decide a rest.
- **Denominator fixed at close, with away seats kept.** Rejected: an away seat could hold a vote open. Away seats leave D instead (§2.2).
- **Host decides ties at expiry.** Rejected: it lets the host override the count at the last moment. Ties at expiry fail (§3.2).
- **Ballots can be changed until close.** Rejected: one ballot per seat, first cast wins (§5.3), so the count cannot be moved by re-voting.
- **Choices shown live.** Rejected: a visible running tally creates pressure on seats that have not voted (§6.4).
- **Players open votes in M4.** Deferred: the spec does not require it, and it adds a second trigger path. See Decisions needed.
- **DM applies rest effects in narration.** Rejected: it breaks the engine-owns-numbers rule (ADR-022 §3, ADR-004).

## Consequences

- M4 item 5 can start after this ADR is accepted and ADR-031 defines away state.
- A vote can delay a round by up to 120 s.
- A 10 min cooldown and a 6-vote session cap bound how often the DM can open a vote.
- Choices are hidden until close. The vote record keeps the choice as an anonymised tally after account deletion.

## Decisions needed

Accepted by Chris's delegate in review:

1. **Player-initiated votes.** DM only in M4; player votes need a new ADR.
2. **Vote timer of 120 s, fixed.**
3. **Ballots count toward the 6 per 60 s mutation budget.**
4. **Choices hidden until close.**
5. **No vote during combat.**
6. **Cooldown 10 min after any close, cap 6 opened votes per session.**
7. **Host tie-break window within the vote deadline, with ties at expiry failed.**

## Verification

- Docs-only change: one new file, `docs/adr/030-rest-vote-and-party-quorum.md`. No existing ADR is edited. No code is written.
- Citations checked against `docs/spec.md` §3.6 AC2 and §6.1, `docs/architecture.md` §2.2 and §3.2, ADR-002, ADR-003, ADR-004, ADR-017 (gameplay class and account deletion), ADR-022 §2, §2.4, §3, §4.2, §7, ADR-029 §1, §2, §5, §8, §11, and ADR-031 §4.1a.
- `prettier --check` run against the branch head. Result recorded in the PR.
