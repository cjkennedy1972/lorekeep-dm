# ADR-029: Party round serialization, submission lifecycle, and OOC chat contract

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-21 · Owner: Sage · Work item: M4 item 0 (`docs/plan/m4-breakdown.md`) · Unblocks: M4 items 1, 2, 5 (chat type prerequisite, card `7bbe618b`)

Append-only: this ADR adds contracts. It does not edit ADR-001 through ADR-028. Where it narrows an earlier statement, it names the ADR and section.

## Context

M4 makes a 2–6 seat party play one shared DM loop. Several contracts that ADR-022 and ADR-023 do not cover must be fixed before implementation:

- Spec §6.2 says the server serializes inputs by receipt timestamp and runs one in-flight DM turn per table. It does not say how submissions are identified, edited, or withdrawn, or how inputs that arrive during generation are held.
- Architecture §6 says input moderation "runs in parallel with other submissions". The M4 breakdown (item 1 and the carry-over section) says chat moderation completes before persist or broadcast and does not run in parallel with round close. These two statements cannot both hold for chat. This ADR resolves that conflict for chat and keeps the parallel rule for DM action input.
- The OOC chat channel has no typed message contract. Item 1 is blocked on it.
- Per-seat rate limits and flood thresholds are not set anywhere.
- The 2,000-character chat cap has been proposed but not ratified.

ADR-005 (Proposed) sets the round shape: collect one editable action per active player, close on all-in, timer, or Resolve now, and queue inputs that arrive during generation. ADR-002 sets one single-writer Room actor per session. This ADR works within both.

## Decision

### 1. Ordering and receipt serialization (new M4 contract)

1. **Receipt sequence.** Every inbound command (action, edit, withdraw, chat, host control) gets, at ingress, a server monotonic receipt time `receivedAt` (ms) and an integer `receiptSeq` that is unique and increasing within the Room. Clients never set either value.
2. **Per-socket serialization.** Each socket has a FIFO chain. A command from a socket enters the input gate (§7) only after the previous command from that same socket has a final gate decision. A slow judge call therefore delays only that socket's own later messages.
3. **Round ordering.** A round batch is built from accepted submissions sorted by `receiptSeq`. Gate decisions may arrive in any order; the batch order does not depend on when a decision returns. This is the spec §6.2 rule ("by receipt timestamp") applied to round actions.
4. **Chat commit order.** Chat commits (persist plus broadcast) in `receiptSeq` order within the Room. A decided message waits only for earlier-received chat messages that are still undecided. Each gate call has a hard 5 s timeout (proposed; ADR-023 measured the judge at 1.0–1.9 s). On timeout the gate returns BLOCK for chat (§7). The worst-case head-of-line delay for chat is therefore 5 s.
5. **Mailbox.** All state transitions run inside the Room's serial mailbox (ADR-002). Gate calls run outside the mailbox and re-enter it with their decision.

Ordering rule summary: round actions are gated in parallel and ordered by receipt. Chat is gated per socket and committed in receipt order behind a barrier. Neither waits for DM generation.

### 2. Round lifecycle

States: `open → closing → resolving → resolved`, plus `closed-empty`.

- **open.** Opened by the Room when the table is `active` (spec §6.1). The round records `eligibleSeats` (seated, not retired, not away at open), `deadline` (now + the table timer), and `roundId`. It emits `RoundOpened`.
- **closing.** Entered on the first of: every eligible seat has an accepted submission (all-in), the deadline passes, or the host sends Resolve now. The round records `closeReason`. The Room waits up to 5 s for gate decisions still pending for this round. Any submission still undecided after that is excluded and its sender receives a private "not counted this round" notice.
- **resolving.** The batch is frozen. Exactly one DM turn runs (ADR-022 invariant T2: `RoundResolved` and its roll events are persisted before narration). Mutations to this round are rejected with `round_closed`.
- **resolved.** Emitted after the DM turn commits. ADR-022 §4.2 applies unchanged: if the turn falls back to a safe narrated outcome, the batch is still consumed and no state changes beyond the fallback.
- **closed-empty.** If the round closes with zero accepted submissions, no DM turn runs and no LLM call is made. The next round opens immediately if the table is still active.

Eligibility is re-checked when the round closes, not only at open. A seat that becomes away (>30 s, spec §6.4) leaves the required set. Its already-accepted submission stays in the batch. Its transition rules are deferred to a focused ADR (§3).

### 3. Submission identity, edit, and withdraw

- **Identity.** A submission is keyed by `(roundId, seatId)`. A seat has at most one live submission per round. Each command carries a client `actionId` for idempotency (ADR-010 envelope). A repeated `actionId` returns the original result and changes nothing.
- **Edit.** An edit is a new gated submission. Only when the new text is allowed does it replace the prior text, atomically. A non-allow edit leaves the prior version in place and is not a withdraw. The edit keeps the original `receiptSeq`, so editing does not move a seat ahead in the batch order. `editedAt` is recorded.
- **Withdraw.** Removes the seat's live submission from the open round. A seat may submit again until close. Withdraw does not need a gate call.
- **After close.** Edit and withdraw return `round_closed`. The seat's submission in the batch is final.

### 4. Accepted vs queued inputs

- **Accepted.** A submission received while a round is `open` (or `closing` and before the close decision) is `accepted` for that round. It counts toward all-in.
- **Queued.** A submission received while a DM turn is in flight (`resolving`) is `queued` for the next round. The sender sees "queued". It does not count toward the current round's quorum. Edit and withdraw apply to the queued item.
- **Promotion.** When the next round opens, queued submissions are promoted to `accepted` in `receiptSeq` order. Their deadline is the new round's deadline. Promotion counts toward all-in for that round.
- **Not queued.** A submission received while the table is `paused` or `ended` is rejected with a reason. It is not held (spec §6.5: pause takes effect at the next generation).

This is the mechanism ADR-005 describes as "queued into the next round". Spec §6.2's "queued and shown as queued" is preserved.

### 5. Timers, pause, and host controls

- Deadlines use the server monotonic clock. A timer value of "off" leaves only all-in and Resolve now.
- Timer changes apply to the next round opened, not the current round. Shortening a running round would be unfair to seats mid-decision.
- Pause freezes the current round's remaining time. Resume restores the remaining time. Pause during `resolving` takes effect after that turn, as spec R-S4 requires.
- Resolve now is accepted only from the host. If sent during `resolving`, it is a no-op. The round closes normally when the turn ends if its condition still holds.

### 6. `ChatMessage` type and lifecycle

Shape (committed record only):

```
ChatMessage {
  messageId      // server UUID
  roomId
  seatId         // sender's seat; no accountId in the record
  receiptSeq     // commit order
  receivedAt     // ms
  text           // NFC-normalized, trimmed, 1..2000 chars (§9)
  channel        // constant "ooc"
  gateDecision   // "allow" with the moderation_log reference id
}
```

Lifecycle:

- A `ChatMessage` exists only after an `allow` decision and commit. A rejected message never produces a `ChatMessage`. A rejected message's text is never stored or broadcast (§7).
- Append-only. No edit, no delete, no reactions, no threads. The breakdown's open question 2 is answered here: plain append-only messages within the existing retention window. (Account deletion still replaces text with `[removed]` per ADR-017.)
- Retained in the 30-day raw-transcript class (§10).
- Events on the Room log: `chat.committed` (with the record above) and `chat.rejected` (no text; carries `reason` and `moderation_log` id). Replay on reconnect returns committed chat only.

### 7. Chat gate order and failure behavior

For each chat command, in order:

1. **Authorization.** Re-check on each send that the socket's ticket is valid (ADR-014 WebSocket ticket, origin check), the seat is current and non-revoked, and the seat is not muted. Departed or muted seats cannot send.
2. **Rate and flood control** (§8). Exceeding a limit returns a neutral private rejection without a judge call.
3. **Hard floor and denylist** (ADR-023 Decision item 1), inline and deterministic.
4. **Judge** (ADR-023 Decision item 2) on the `moderate` endpoint, strict JSON `{verdict, category}`.
5. **Commit barrier** (§1.4), then persist and broadcast.

Steps 3 and 4 run strictly before persist or broadcast. Chat is never persisted and then checked.

Failure behavior for chat:

- Hard-floor or denylist error: BLOCK (ADR-023 fail-closed table).
- Judge outage or 5 s timeout: BLOCK. Chat has no hold queue. A held message would commit later and break receipt order, so the sender is told to resend. This is a deliberate narrowing of ADR-023's "tier-category outage = HOLD" for chat only; see Decisions needed.
- Any non-allow returns one neutral private rejection to the sender only. Nothing is broadcast. A `moderation_log` row is written with the reason and category and no raw text (ADR-023; spec A24).

Latency is not a gate for this slice. The breakdown states that M4 does not require the input-judge latency fix. ADR-023's measured misses carry into chat unchanged, and chat must not bypass the gate to meet a latency target.

### 8. Per-seat rate limits and flood control (concrete thresholds)

All values are proposed defaults, set per Room and tunable only by the operator config. Counts are per seat unless marked per table.

Chat:

- **Burst:** 5 chat gate submissions per 10 s (token bucket, capacity 5, one token refilled every 2 s). Rationale: covers a paste-and-reply burst. Sustained ceiling of 30 per minute bounds judge spend per seat to roughly one call every 2 s, well inside the measured 1.0–1.9 s judge latency.
- **Sustained:** 40 submissions per 10 min. Rationale: about one message every 15 s over a session, which is above normal table chat.
- **Duplicates:** the same normalized text from the same seat within 60 s is dropped before the gate. It still consumes one token. Rationale: stops repeat-spam from reaching the judge.
- **Per table:** 120 gate calls per minute across all seats. Over the limit returns a neutral "chat is busy" rejection without a judge call. Rationale: caps total judge spend for a six-seat table at about 2 per second.
- **Non-allow streak:** 3 non-allow decisions from one seat within 5 min mutes that seat's chat for 5 min. The host can lift it early. Rationale: stops probing of the filter. The mute is recorded in `moderation_log`.

Round actions (submit, edit, withdraw):

- **Mutations:** 6 per 60 s per seat (edits and withdraws count). Rationale: a seat can revise a plan several times in a round without flooding gate calls.
- **Edits per round:** 10 per seat. Rationale: bounds churn in a 120 s round.
- Action text passes the same gate as chat (ADR-023), with the same burst bucket applied to gate calls.

Connection:

- Maximum frame 10 KB (chat payload 8 KB, which is 2000 characters at 4 bytes UTF-8 worst case, plus envelope). Rationale: the frame size follows from the character cap and does not need a separate number.

These thresholds belong in M4 item 1's code. This ADR sets the values and their reasons. It does not add code.

### 9. Chat length cap: 2,000 characters (ratified)

The cap is ratified at **2,000 characters** of NFC-normalized text, below the 30,000-character DM input cap. Reasons:

- Chat is social text: 2,000 characters is about 350 words, more than any normal table message.
- It bounds the judge's input and the worst-case frame (§8).
- It limits paste-based abuse of the 30-day chat store.
- The DM never reads chat (§11), so the larger input cap gives chat nothing.

Counting is after NFC normalization and trimming. Empty text is rejected.

### 10. Retention and reports

- **Chat messages** are user-generated text in the 30-day raw-transcript class (spec A24, §9.4; ADR-017). They expire 30 days after creation.
- **`moderation_log` rows** for chat carry no raw text and follow the 30-day operational class.
- **Chat reports** (report-a-message, spec R-S6) snapshot the reported text and context into `message_reports`. The snapshot follows ADR-028's clocks: 90 days while open, 30 days after review or dismissal, 90 days after reopen. Legal hold (`legal_hold`, migration 0031) overrides them. Because the snapshot is a separate record, the chat message can expire at 30 days without losing evidence under review. ADR-028 remains the only place that sets report clocks; this ADR does not change them.

### 11. OOC never reaches DM prompts or narration

- Chat is stored and replayed through `chat.*` events and a separate chat record. It is not in the round action store or the DM turn event stream.
- The DM prompt assembler reads an **allowlist** of event types (`round.action.accepted`, `round.resolved`, state and map events, recap). Chat is not on the list. An allowlist is used because a new event type must be added on purpose.
- Summaries, recaps, and memory (architecture §4, R-M1..M3) read only the same allowlist. OOC text is never quoted or echoed in narration.
- M4 item 9 verifies this with a test: a generated set of chat messages (including injection-style strings) must produce DM prompts that contain none of them.

## Answers to the brief

**Is ADR-022 sufficient for rest quorum?** No. ADR-022 specifies the `call_for_rest` tool shape (§2) and turn ordering (T2, §4.2). It does not define who counts toward majority (all seated seats or only eligible non-away seats), what a tie is when the host is also a voter, timeout behavior, whether a vote may open during an in-flight turn, or persistence of vote results. A focused ADR is required. Proposed title: **ADR-030 Rest vote and party quorum**. It is needed before M4 item 5 starts. Recommended defaults for its questions are listed under Decisions needed.

**Is ADR-022 sufficient for away and autopilot transitions?** No. ADR-022 covers the DM turn protocol, not presence. ADR-005 (Proposed) sets the 30 s away threshold and says autopilot is a pure engine function, but it leaves open Q7 ("autopilot vs vote") and says nothing about transitions: reconnect within 2 s restoring control (spec §6.4), what happens to a queued submission when a seat goes away, autopilot behavior in exploration versus combat, and hysteresis to stop flapping at the 30 s edge. A focused ADR is required. Proposed title: **ADR-031 Presence, away transitions, and defensive autopilot**. It is needed before M4 item 4 starts.

Neither focused ADR is written here. This ADR states what it needs from them: round eligibility (§2) and the queued-submission rule (§4) depend on away state.

## Alternatives considered

- **Global serialization of all inputs including action gates.** Simpler ordering, but one slow judge stalls the whole table. Rejected: the parallel action gate is in ADR-022's latency path (arch §2.3).
- **Chat committed in gate-completion order, no barrier.** Simpler, no head-of-line delay. Rejected because two players reading the same log would see different orders after reconnect. The 5 s bounded barrier keeps one order for everyone.
- **Chat held (HOLD) on judge outage, as for DM output.** Consistent with ADR-023 but breaks receipt order when the held message commits later. Rejected for chat; see Decisions needed.
- **Edit as withdraw-and-resubmit.** Simpler but moves the seat to the back of the batch order. Rejected: an edit should not reward or punish timing.
- **Chat in the DM event stream with a denylist for the prompt builder.** Rejected: a new event type would leak by default. The allowlist fails closed.

## Consequences

- M4 item 1 can start once this ADR is accepted: the `ChatMessage` type (§6) and gate order (§7) are fixed.
- Chat can be delayed up to 5 s behind an earlier undecided message in the same table. Accepted as the cost of one order for everyone.
- Chat judge calls share the moderation endpoint with DM output. The per-table bucket (§8) protects DM narration from chat load. The DM's own gate budget is not reduced by this ADR and is measured in M4 item 9.
- Thresholds in §8 are proposals with stated reasons. They will need tuning from M4 evidence. Changing them is a config change, not an ADR change, unless the rationale changes.
- ADR-022 is unchanged. Its T2 ordering and §4.2 fallback are preserved by §2.

## Decisions needed

From Atlas (routine within delegation, flagged because they set behavior):

1. **Chat judge outage = BLOCK (neutral rejection), not HOLD.** This narrows ADR-023's HOLD rule for chat only. Recommendation: accept.
2. **Chat commit barrier with a 5 s head-of-line bound (§1.4)**, instead of per-socket order only. Recommendation: accept; the cost is one bounded delay for one consistent order.
3. **§8 numbers** (burst 5 / 10 s, sustained 40 / 10 min, table 120 / min, non-allow mute at 3 in 5 min). Recommendation: accept as starting values for M4 item 1.

From Chris (scope):

4. **Write ADR-030 (rest vote and quorum) and ADR-031 (away and autopilot transitions) before items 4 and 5 start.** Both are required per §3. Recommendation: Atlas drafts them or assigns Sage, since M4 item 4 depends on ADR-031.
5. **Workboard cards `bb863de6` and `7bbe618b`.** I could not fetch their current text from this session. This ADR relies on the breakdown's description of `7bbe618b` as the chat-type blocker. Confirm the card matches before item 1 is created.

## Verification

- Docs-only change: one new file, `docs/adr/029-party-round-and-chat-contracts.md`. No existing ADR is edited. No code is written.
- `npm run format:check` (prettier) run against the branch head. Result recorded in the PR.
