# ADR-030: Rest vote and party quorum

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 5 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-017, ADR-022, ADR-029 (round states, timers, pause, judge budgets, OOC), ADR-031 (away state; ADR-031 merges first). M4 item 5 is blocked on the ADR-031 merge.

Append-only: this ADR defines the rest vote. It does not edit ADR-001 through ADR-029, and it does not edit `docs/architecture.md`. It fills the `call_for_rest` row that ADR-022 §2 deferred to M4. It adds five event types, listed in §6.1 as additions to the architecture §15.6 event list. It extends the ADR-022 §2.4 closed reason enum, listed in §1. ADR-022 is not edited.

## Context

- ADR-022 §2 defers `call_for_rest` to M4 with the reason "opens a party vote; solo has no quorum". It gives no schema, no lifecycle, no eligible-voter rule, and no tie rule.
- Spec §3.6 AC2: rest requires party consensus in multiplayer (majority vote, host tiebreak). The spec gives no timer for a vote.
- Architecture §2.2 has `exploration → rest` on "party vote passes" and `rest → exploration` on "rest resolved".
- Architecture §3.2 gives `call_for_rest(type)` as "opens a party vote" with "Engine applies rest on pass".
- Architecture §15.6 is the v0.2 event-types list.
- M4 item 5 requires that a failed or expired vote changes no rest state, that the engine alone applies SRD rest effects, and that the vote and its result persist and are visible to all players.
- ADR-029 §2 defines round states, §4 the accepted and queued input categories, and §5 pause and timers. ADR-029 §8 sets the per-seat mutation budget and judge budgets. ADR-029 §11 keeps OOC content out of DM prompts.
- ADR-017 §Data classes puts events and snapshots in the gameplay class. ADR-022 §4.2 defines the fallback turns.

## Decision

### 1. Opening a vote

1. **Trigger.** In M4, only the DM opens a vote, by calling `call_for_rest`. The server validates every call against §1.6 and §1.2; player text is never itself a trigger. Players cannot open a vote (see Decisions needed).
2. **Arguments.** `{type: "short" | "long"}`. Any other value is rejected and no vote opens.
3. **Timing.** The vote opens when the DM turn that called the tool commits. It does not open mid-turn, so the T2 ordering in ADR-022 holds and the Room's single writer (ADR-002) applies the change.
4. **Fallback turns never open a vote.** A turn that ADR-022 §4.2 resolves through a fallback cannot call `call_for_rest`, even if the DM's output contained the call.
5. **Idempotent on turnId.** The open is keyed by the committing turn's `turnId`. A replayed or retried commit for the same turn does not open a second vote.
6. **Preconditions.** The table is `active` and not paused (ADR-029 §5). The table is in the exploration state (architecture §2.2). No round is `open`, `closing`, or `resolving`. No other vote is open. If a precondition fails, no vote opens and the DM receives `rest-not-allowed` with reason `precondition`.
7. **Rate limits on opening.** At most one vote may open per 10 min per table, measured from the close of the previous vote, whatever its outcome. At most 6 votes may be opened per table. The count is persisted with the table, so closing and reopening the Room does not reset it. If either limit binds, no vote opens and the DM receives `rest-not-allowed` with reason `cooldown` or `session-limit`.
8. **A vote is a sub-state of exploration.** An open vote lives inside the exploration state (architecture §2.2). `rest` is entered only inside the closing step (§6.3).
9. **A vote blocks round opening.** While a vote is open, no round can open. A vote therefore delays a round by at most its timer length (§4).
10. **Player actions during a vote.** While a vote is open, player round actions are accepted and queued for the next round, under the ADR-029 §4 queued-input rules. A queued action may be edited. OOC chat is unaffected by the vote.
11. **Solo.** Solo has no vote. Solo rest stays a client command, `POST /session/:id/rest` (ADR-022 §2). The server MUST reject that request with `rest-not-allowed` and reason `multiplayer` whenever the session has more than one seated, non-retired seat, regardless of presence. This check runs server-side on every request, including sessions that became multiplayer after the client loaded; multiplayer rest happens only through this vote.

**Error codes.** This ADR extends the closed reason enum of ADR-022 §2.4 with the codes below. ADR-022 is not edited.
- `rest-not-allowed`, with a `reason` of `precondition`, `cooldown`, `session-limit`, or `multiplayer`.
- `vote-closed`, returned when a cast arrives after close (§5.5).
- `ballot-not-allowed`, returned when a cast fails the re-check in §5.1. ACCEPTED: this ADR declares it as an extension of the ADR-022 §2.4 enum. ADR-022 is not edited.

### 2. Eligible voters and the count N

1. **Eligible set at open.** The eligible set is every seated, non-retired seat at open, regardless of presence. Mute is a chat restriction (ADR-031 §3.5), so it does not affect eligibility. A seat that joins after open is not eligible for that vote.
2. **N is fixed at open for every cause,** and is the size of the eligible set at open. N never changes after open, whatever happens to a seat: away, revoked, departed, kicked, or banned.
3. **Seats stay in N.** An `away` seat stays in N. If it had cast, its ballot is kept and counts. If it had not cast, it counts as `no`. While away it cannot cast, because a cast requires control (ADR-031 §3.1, §4.2).
   - A seat that is `revoked` (kick, ban, retirement, or departure) stays in N and keeps its counted ballot, or counts as `no` if it had not cast. It can cast nothing further. Revocation removes control and chat only; it never changes N or the result.
4. **Early-close arithmetic uses N.** Every threshold in §4 is computed with N as fixed at open.
5. **Non-cast seats count as no.** A seat in N that has not cast counts as `no` in the pass test. There is no abstention.
6. **Two choices only.** A ballot is `yes` or `no`. There is no abstain option.
7. **A muted seat in N** can cast, because mute restricts chat only (ADR-031 §3.5). It is counted like any other seat.
8. **Round rule is separate.** The round required-set exclusion for `away` and `revoked` seats (ADR-031 §4.1) applies to rounds only. It does not change N. N is the rest-vote rule only, and it does not apply to rounds.

### 3. Pass, tie, and host break

This section narrows spec §3.6 AC2, which says "majority vote, host tiebreak". The narrowing is this ADR's own decision, not a spec citation: the host seat must be in N and have cast (item 4), and the host gets one tie-break action after a tie is established and before the vote deadline (item 3).

1. **Pass test.** The vote passes when yes is more than N / 2.
2. **Tie is failed unless the host acts.** A tie is yes equal to no, counting non-cast seats in N as no. A tie fails at the deadline with reason `tie-failed` unless the host tie-break in §3.3 has resolved it. A tie cannot be resolved by anyone else.
3. **Host window.** The host window opens only when every seat in N has cast and yes equals no. The host's own ballot counts once, as a normal ballot. The host then gets one separate tie-break action, a choice of `yes` or `no`, which must arrive before the deadline. The tie-break is one cast, first wins, keyed `(voteId, hostSeat, "tiebreak")`. A second tie-break is rejected. There is no host reassignment in M4.
4. **Host eligibility.** The tie-break needs the host seat to be in N, to hold control, and to have cast a ballot. The tie fails with reason `tie-failed`: at once when the host seat is revoked, and at expiry when it is away (§4.6). An `away` host cannot cast (ADR-031 §3.1), so the all-cast condition in §3.3 never holds while the host is away. This is intended: an away host blocks the tie-break, and the tie fails (ADR-031 §4.9).
5. **Host outcome.** The host's choice is final. `yes` passes the vote with reason `host-tiebreak`. `no` fails it with reason `host-tiebreak`.
6. **No host action by deadline.** The vote fails with reason `tie-failed` (§4.6). This matches §4.6.
7. **The tie-break is a cast.** It passes the same re-check as §5.1, uses the key `(voteId, hostSeat, "tiebreak")`, and counts toward the per-seat mutation budget (§5.4).

### 4. Timing and closing

1. **Timer.** The vote timer is 120 s. It is fixed for M4 and is not host-configurable. It is separate from the exploration round timer in spec §6.1, which the host can change.
2. **Deadline is wall-clock.** At open the engine stores `deadlineAt` as a UTC timestamp. A monotonic clock is not used, because it does not survive a restart.
3. **Pause.** On pause the engine stores the remaining milliseconds. On resume it writes a new `deadlineAt` from the remaining milliseconds (ADR-029 §5). A ballot sent while paused is rejected and not queued (ADR-029 §4, "Not queued").
4. **Early pass.** The vote closes as passed as soon as yes is more than N / 2. Reason `majority`. Seats in N that have not cast, including `away` seats, count as `no` here, so presence cannot lower the pass bar.
5. **Early fail.** The vote closes as failed as soon as yes plus the number of seats in N that have not cast is strictly less than N / 2. Reason `no-majority-early`. `away` seats in N count as not cast. The strict bound keeps a tie reachable: if yes plus uncast equals N / 2, every remaining seat could still cast a tie, and a tie must reach the host window (§3.3) rather than close as a fail.
6. **Expiry.** At `deadlineAt` the vote closes, using N. Non-cast seats in N count as `no` here, as in §4.4 and §4.5. If yes is more than N / 2 it passes, reason `majority`. If yes equals no, it fails with reason `tie-failed` (§3.2, §3.6). Otherwise it fails with reason `expired`.
7. **All cast.** When every seat in N has cast and the result is not a tie, the vote closes at once. A pass is reason `majority`; a fail is reason `no-majority`. A tie opens the host window in §3.3.
8. **Reason mapping.** `RestVoteClosed` records one of the following:
   - `majority`: a pass by early pass (§4.4), at all-cast (§4.7), or at expiry (§4.6).
   - `no-majority-early`: an early fail (§4.5).
   - `no-majority`: an all-cast fail (§4.7).
   - `host-tiebreak`: the host's tie-break outcome (§3.5).
   - `tie-failed`: a tie at expiry with no host action (§3.6), or a host seat that is revoked or away while a tie is possible (§3.4).
   - `expired`: deadline reached, yes below no, and not all seats have cast.
   - `cancelled`: the vote was reverted (§6.8).
9. **Cooldown.** The close of any vote, whatever its outcome, starts the 10 min table cooldown in §1.7.

### 5. Casting ballots

1. **Re-check at cast.** Every cast re-checks, at cast time: the seat's ticket is valid, the seat is in N, the seat is not retired, and the seat holds control (ADR-031 §3.1). A revoked seat has no control, so it fails this check, and an away seat fails it too. A failed check returns `ballot-not-allowed` and records nothing.
2. **Idempotency key.** Each cast carries the key `(voteId, seat)`. A replayed cast with the same key returns the stored result and records nothing new.
3. **One ballot per seat, first cast wins.** A second, different ballot from a seat is rejected, except for the host tie-break cast keyed `(voteId, hostSeat, "tiebreak")` under §3.3. The separate tie-break is allowed only once. There is no change to the original ballot after a cast.
4. **Casts skip the judge budgets.** A cast is an enum with no free text, so it makes no judge call. It is not subject to the ADR-029 §7 or §8 judge budgets. Each cast counts toward the per-seat mutation budget of 6 per 60 s (ADR-029 §8).
5. **Late casts** after close are rejected with `vote-closed`. A replay of a cast after close returns the stored status only, never the choice.

### 6. Effects and persistence

1. **Events.** The vote adds five event types: `RestVoteOpened{voteId, type, eligibleSeats, deadlineAt, openedByTurnId}`, `RestVoteCast{voteId, seat, choice}`, `RestVoteCastNotice{voteId, seat}`, `RestVoteClosed{voteId, outcome, reason, yes, no}`, and `RestApplied{voteId, type, effects}`. `RestVoteCast` is server-internal: it carries the choice and is never broadcast. `RestVoteCastNotice` is the broadcast: it carries the seat and the word `cast`, and no choice. `RestApplied` is emitted only on a pass. These five types are the additions to the event list in architecture §15.6. This ADR declares them. `docs/architecture.md` is not edited.
2. **Engine applies rest.** On a pass, the rules engine computes and applies the SRD rest effects in the same serial mailbox step that closes the vote (ADR-002, ADR-022 §3). The DM never writes rest effects.
3. **Rest state is transient.** The architecture §2.2 `rest` state exists only inside that mailbox step. The Room returns to the exploration state in the same step that applies the effects.
4. **Visibility before close.** Clients see that a vote is open, its type, and its `deadlineAt`. Clients see that a seat has cast through `RestVoteCastNotice`, which carries no choice. `RestVoteCast` is never broadcast, at open, during the vote, or at close. Choices reach clients only as the tally in `RestVoteClosed` (§6.5).
5. **Visibility at close.** `RestVoteClosed` carries the yes and no tally, the outcome, and the reason, and it goes to all seats. This visibility rule is this ADR's own rule.
6. **DM prompt exclusion.** `RestVoteCast` events, which carry the choice, are excluded from the DM prompt allowlist. `RestVoteCastNotice` carries no choice and is not a source of ballot content. ADR-029 §11 keeps OOC content out of DM prompts; this ADR applies the same kind of exclusion to ballot choices. The DM sees only the close outcome, through `RestVoteClosed`.
7. **Persistence.** The events go to the append-only log (ADR-003). A reconnecting client gets an open vote from snapshot plus replay. Replay carries `RestVoteCastNotice` and never `RestVoteCast`.
8. **Rewind.** If a `TurnReverted` removes the turn that opened a vote, the vote closes as `cancelled` and applies nothing. If the reverted turn's rest effects were applied, the restored snapshot undoes them (ADR-003). Only the host can rewind (spec §6.5). Rewinding the opening turn after a passed vote undoes its rest effects; that is intended.
9. **Small tables.** For N ≤ 3, a published tally can reveal a seat's choice, because the other counts are known. This is accepted. The tally publishes counts only, never a seat-linked choice.

### 7. Retention and account deletion

1. **Class.** Vote events (`RestVoteOpened`, `RestVoteCast`, `RestVoteCastNotice`, `RestVoteClosed`, `RestApplied`) are in the ADR-017 class **Gameplay data**. ADR-017 §Data classes reads, exactly: "Gameplay data | events, snapshots, registry | live while session active; `archived` after 14 days idle; deleted 90 days after archive unless claimed (spec A4)". The vote events take the same retention as those events and snapshots.
2. **Account deletion.** ADR-017's account-deletion rule is quoted here, not only cited: "Sessions where the deleted account is only a seat are redacted, not purged." Redaction is the only change made to the log. For every vote in every session where the deleted account held a seat, including shared sessions, the vote's data is scrubbed as follows:
   - All `RestVoteCast` and `RestVoteCastNotice` events for that vote are removed. This removes each per-ballot choice and each seat.
   - `eligibleSeats` is removed from `RestVoteOpened`. Its other fields (`voteId`, `type`, `deadlineAt`, `openedByTurnId`) carry no seat or choice and are kept.
   - The `RestVoteClosed` outcome and reason are kept; its yes and no counts are set to null whenever the deleted seat cast a counted ballot in that vote. Otherwise, the tally is kept unchanged. This prevents recovering the deleted seat's choice by subtracting remaining ballots from the tally.
3. **Only the scrubbed outcome survives.** After scrubbing, the vote's outcome survives as `RestVoteClosed{voteId, outcome, reason, yes, no}`; when a deleted seat cast a counted ballot, yes and no are null. Item 2 is the rule that produces it. No per-ballot choice or seat list survives account deletion.

### 8. Failed or expired vote

A failed, expired, cancelled, or `tie-failed` vote emits `RestVoteClosed` only. It changes no rest state and applies no effects (M4 item 5). The DM sees the outcome in its next turn context and may narrate it. The 10 min cooldown in §1.7 still applies.

## Alternatives considered

- **Simple majority of ballots cast, abstentions excluded.** Rejected: two of six seats could decide a rest.
- **Away seats leave N.** Rejected: a seat going away would lower N and so lower the pass bar, letting presence decide a rest. Away seats stay in N and count as `no` until they cast (§2.3).
- **Host decides ties at expiry.** Rejected: it lets the host override the count at the last moment. Ties at expiry fail (§3.2).
- **Ballots can be changed until close.** Rejected: one ballot per seat, first cast wins (§5.3), so the count cannot be moved by re-voting.
- **Choices shown live.** Rejected: a visible running tally creates pressure on seats that have not voted (§6.4).
- **Players open votes in M4.** Deferred: the spec does not require it, and it adds a second trigger path. See Decisions needed.
- **DM applies rest effects in narration.** Rejected: it breaks the engine-owns-numbers rule (ADR-022 §3, ADR-004).

## Consequences

- M4 item 5 is blocked on the ADR-031 merge, and can start after this ADR is accepted.
- A vote can delay a round by up to 120 s.
- A 10 min cooldown and a 6-vote session cap bound how often the DM can open a vote.
- Choices are hidden until close. After account deletion, per-seat ballot events and any identifying seat list are removed; counts are nulled if the deleted seat cast a counted ballot (§7.2).

## Decisions needed

Decided by Chris's delegate in review:

1. **Player-initiated votes.** DM only in M4; player votes need a new ADR.
2. **Vote timer of 120 s, fixed.**
3. **Casts count toward the 6 per 60 s mutation budget, and skip the judge budgets (§5.4).**
4. **Choices hidden until close.**
5. **No vote during combat.**
6. **Cooldown 10 min after any close, cap 6 opened votes per table, persisted, so closing and reopening the Room does not reset it.**
7. **Host tie-break window within the vote deadline; ties at expiry fail.**
8. **Quorum.** Abstain counts as `no`. The denominator is N fixed at open (§2.2). Pass requires yes more than N / 2. Early fail is strict: it fires only when yes plus uncast seats in N is strictly less than N / 2 (§4.5). A tie at N / 2 stays reachable and goes to the host window (§3.3) when all seats have cast.
9. **N is fixed at vote open for every cause.** An `away` seat stays in N. If it had cast, its ballot is kept and counts. If it had not cast, it counts as `no`. A `revoked` seat (kick, ban, retirement, or departure) stays in N and keeps its counted ballot, or counts as `no` if it had not cast. It can cast nothing further. Revocation removes control and chat only; it never changes N or the result (§2.3). This matches ADR-031 §4.2.
10. **`ballot-not-allowed`: ACCEPTED.** This ADR declares it, alongside `rest-not-allowed` and `vote-closed`, as an extension of the ADR-022 §2.4 enum. ADR-022 is not edited.

## Verification

- Docs-only change: one file, `docs/adr/030-rest-vote-and-party-quorum.md`. No existing ADR is edited, and `docs/architecture.md` is not edited.
- Citations checked against `docs/spec.md` §3.6 AC2 and §6.1, `docs/architecture.md` §2.2, §3.2, and §15.6, ADR-002, ADR-003, ADR-004, ADR-017 (gameplay class and account deletion), ADR-022 §2, §2.4, §3, §4.2, ADR-029 §1, §2, §4, §5, §8, §11, and ADR-031 §2.4, §2.7, §3.1, §4.2, and §4.9.
- Test cases for M4 item 5:
  - All-cast tie: every seat in N has cast and yes equals no. No early close fires. The host window opens (§3.3). A host tie-break closes the vote with `host-tiebreak`; with no tie-break by the deadline, it closes with `tie-failed`.
  - Early-fail boundary: N = 4, yes = 1, two seats cast no, one seat uncast. Yes plus uncast equals N / 2, so no early fail fires and the vote stays open.
  - Early fail fires: N = 4, yes = 0, three seats cast no, one seat uncast. Yes plus uncast is 1, strictly less than N / 2, so the vote closes as failed with `no-majority-early` (§4.5).
  - Away host: the host seat is away when a tie appears. The host window never opens, because the all-cast condition cannot hold while the host cannot cast. The tie fails at expiry with `tie-failed` (§3.4).
- Revoked host: the host seat is revoked when a tie appears. The tie fails at once with `tie-failed` (§3.4).
- Departed after casting: N = 4. Seats A and B cast yes, seat C casts no, and seat D casts no and then departs (revoked). N stays 4, D's no is kept, and the result is the same as if D had stayed connected: an all-cast tie, so the host window opens.
- Run by the author before push: prettier and the stale-sentence sweep.
