# ADR-030: Rest vote and party quorum

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 5 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-029 (round states, timers, pause), ADR-031 (away state)

Append-only: this ADR defines the rest vote. It does not edit ADR-001 through ADR-029. It fills the `call_for_rest` row that ADR-022 §2 deferred to M4, and it adds three event types to the ADR-022 §7 list.

## Context

- ADR-022 §2 defers `call_for_rest` to M4 with the reason "opens a party vote; solo has no quorum". It gives no schema, no lifecycle, no eligible-voter rule, and no tie rule.
- Spec §3.6 AC2: rest requires party consensus in multiplayer (majority vote, host tiebreak). The spec gives no timer for a vote.
- Architecture §2.2 has `exploration → rest` on "party vote passes" and `rest → exploration` on "rest resolved".
- Architecture §3.2 gives `call_for_rest(type)` as "opens a party vote" with "Engine applies rest on pass".
- M4 item 5 requires that a failed or expired vote changes no rest state, that the engine alone applies SRD rest effects, and that the vote and its result persist and are visible to all players.
- ADR-029 §2 defines the round states and §5 defines pause and timer behavior. A vote reuses both.

## Decision

### 1. Opening a vote

1. **Trigger.** In M4, only the DM opens a vote, by calling `call_for_rest`. Players cannot open a vote (see Decisions needed).
2. **Arguments.** `{type: "short" | "long"}`. Any other value fails closed as `ToolCallRejected` (ADR-022 §7).
3. **Timing.** The vote opens when the DM turn that called the tool commits. It does not open mid-turn, so the T2 ordering in ADR-022 holds and the Room's single writer (ADR-002) applies the change.
4. **Preconditions.** The table is `active` and not paused (ADR-029 §5). No round is `open`, `closing`, or `resolving`. No other vote is open. The table is in exploration, not combat (architecture §2.2). If a precondition fails, no vote opens and the DM receives `rest-not-allowed` (a new code for the ADR-022 §2.4 catalogue).
5. **No overlap.** A vote and a round never run at once. A round cannot open while a vote is open, and a vote cannot open while a round is open. A vote therefore delays a round by at most its timer length (§4).
6. **Solo.** Solo has no vote. Solo rest stays a client command, `POST /session/:id/rest` (ADR-022 §2), and this ADR does not change it.

### 2. Eligible voters and the majority

1. **Eligible voters are fixed at open.** They are seated, not retired, and not away (ADR-031). The count `N` is the number of eligible voters at open.
2. **Pass threshold.** A vote passes when yes votes are more than `N / 2`.
3. **A seat that goes away after open** keeps its place, its vote, and its count in `N`. It may still vote when it returns.
4. **A seat that is retired after open** leaves `N` and its vote is discarded. The vote then closes if the remaining eligible voters have all voted, or if the outcome is already fixed under §4.
5. **A seat that joins after open** is not eligible for that vote.
6. **Abstaining counts as no.** Only a `yes` counts toward passing.

### 3. Tie and host break

1. **A tie** is a close where yes equals no, with abstentions counted as no. It can happen only when `N` is even.
2. **The host breaks a tie** by the host's recorded choice. If the host is not an eligible voter, or the host has not voted, the tie fails.
3. **No early tie-break.** The host's choice does not decide the vote before close.

### 4. Timing and closing

1. **Timer.** The vote timer is 120 s. It is fixed for M4 and is not host-configurable. It matches the exploration round default in spec §6.1.
2. **Pause.** Pause freezes the vote timer, and votes are rejected while paused, as ADR-029 §5 requires for submissions.
3. **Early pass.** The vote closes as passed as soon as yes is more than `N / 2`.
4. **Early fail.** The vote closes as failed as soon as yes plus the number of undecided eligible voters is at most `N / 2`.
5. **All voted.** The vote closes when every eligible voter has voted, and the §3 rules apply.
6. **Expiry.** The vote closes at the deadline. If the pass threshold is not met, the outcome is failed with reason `expired`.
7. **Reasons.** `RestVoteClosed` records one of `majority`, `no-majority`, `host-tiebreak`, `tie-failed`, `expired`, or `cancelled`.

### 5. Casting votes

1. **Votes are enums.** A cast is `yes` or `no`, so it skips the chat gate and makes no judge call (ADR-029 §7 and §8 budgets do not apply).
2. **Votes are changeable** until close. A later cast replaces the earlier one.
3. **Rate limit.** Each cast counts toward the per-seat mutation budget of 6 per 60 s (ADR-029 §8).
4. **Late casts** after close are rejected with `vote-closed`.

### 6. Effects and persistence

1. **Events.** The vote adds three event types to the ADR-022 §7 list: `RestVoteOpened{voteId, type, eligibleSeats, deadline, openedByTurnId}`, `RestVoteCast{voteId, seat, choice}`, and `RestVoteClosed{voteId, outcome, reason, yes, no}`. A passed vote also emits `RestApplied{voteId, type, effects}`.
2. **Engine applies rest.** On a pass, the rules engine computes and applies the SRD rest effects in the same serial mailbox step that closes the vote (ADR-002, ADR-022 §3). The DM never writes rest effects.
3. **Rest state is transient.** The architecture §2.2 `rest` state exists only inside that mailbox step, so the Room returns to `exploration` in the same step that applies the effects.
4. **Visibility.** Every seat sees that a vote is open, who has voted, and the deadline. Choices are shown to all only at close. Hiding choices while open keeps a vote from becoming a pressure test. Spec §3.6 requires that the result be visible, and this rule satisfies it.
5. **Persistence.** The events go to the append-only log (ADR-003). A reconnecting client gets an open vote from snapshot plus replay.
6. **Rewind.** If a `TurnReverted` removes the turn that opened a vote, the vote closes as `cancelled` and applies nothing. If the reverted turn's rest effects were applied, the restored snapshot undoes them (ADR-003).

### 7. Failed or expired vote

A failed, expired, or cancelled vote emits `RestVoteClosed` only. It changes no rest state and applies no effects (M4 item 5). The DM sees the outcome in its next turn context and may narrate it.

## Alternatives considered

- **Simple majority of votes cast, abstentions excluded.** Rejected: two of six seats could decide a rest.
- **Denominator fixed at close.** Rejected: a seat leaving after open would make passing easier.
- **Host decides ties before close.** Rejected: it lets the host override the count early.
- **Players open votes in M4.** Deferred: the spec does not require it, and it adds a second trigger path. See Decisions needed.
- **DM applies rest effects in narration.** Rejected: it breaks the engine-owns-numbers rule (ADR-022 §3, ADR-004).

## Consequences

- M4 item 5 can start after this ADR is accepted and ADR-031 defines away state.
- A vote can delay a round by up to 120 s.
- Choices are hidden until close. Players who want to see the running count can read it from the who-has-voted list.

## Decisions needed

Routine within delegation, flagged because they set behavior:

1. **Player-initiated votes.** Recommendation: DM only in M4; player votes need a new ADR.
2. **Vote timer of 120 s, fixed.** Recommendation: accept. The spec gives no vote timer, and this matches the round default.
3. **Votes count toward the 6 per 60 s mutation budget.** Recommendation: accept.
4. **Choices hidden until close.** Recommendation: accept.
5. **No vote during combat.** Recommendation: accept, since architecture §2.2 puts rest only in exploration.

## Verification

- Docs-only change: one new file, `docs/adr/030-rest-vote-and-party-quorum.md`. No existing ADR is edited. No code is written.
- Citations checked against `docs/spec.md` §3.6 AC2 and §6.1, `docs/architecture.md` §2.2 and §3.2, ADR-002, ADR-003, ADR-022 §2, §2.4, §3, §7, and ADR-029 §2, §5, §7, §8.
- `prettier --check` run against the branch head. Result recorded in the PR.
