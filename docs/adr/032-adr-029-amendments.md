# ADR-032: Amendments to ADR-029 (pause resume, mute and control, judge budget allocation)

Status: Proposed (draft PR) · Date: 2026-10-21 · Owner: Atlas (tech lead, Chris's delegate) · Work item: M4 items 1, 4, and 5 · Depends on: ADR-029, ADR-030, ADR-031. Merge order: ADR-031, then ADR-030, then this ADR, then the M4-1 chat slice (PR #266).

Append-only: this ADR amends ADR-029 §5, §7, and §8 by decision. It does not edit ADR-029 or any other merged ADR. Where this ADR and ADR-029 differ on the points below, this ADR governs.

## Context

- ADR-031 §4.7 decides that a table paused because no seat is confirmed connected resumes on its own when a seat reaches `connected`. ADR-029 §5 describes pause and resume in terms of the host.
- ADR-031 §3.5 decides that mute restricts chat only and does not bar game control. ADR-029 §7 applies the mute test in the chat gate, and its wording can be read as barring control on mute.
- ADR-029 §8 describes one pool shared by chat and action-input gate calls: 3 calls in flight and 200 calls per minute, next to a reserved share for DM output gating (1 in flight and 40 per minute). Review of the M4-1 chat slice found that one shared pool lets a chat flood starve player action judging.
- ADR-029 §1.4 sets at most 5 s of gate time per chat message.

## Decision

1. **Pause and resume (amends ADR-029 §5).** A pause the host requests ends only when the host resumes. A pause caused by zero confirmed-connected seats ends on its own when at least one seat reaches `connected` (ADR-031 §4.7). No host action is needed for it.
2. **Mute and control (amends ADR-029 §7).** Mute restricts chat only. The §3.5 control check in ADR-031 has no mute test. The ADR-029 §7 chat gate keeps the mute test for chat sends. A muted seat keeps game control and may cast a rest vote (ADR-030 §2.3). Where ADR-029 §7 reads as barring control on mute, this decision governs.
3. **Judge budget allocation (amends ADR-029 §8).** The 3 in-flight slots and 200 calls per minute that ADR-029 §8 shares between chat and action-input gate calls are allocated as follows:
   - Chat gate calls: at most 2 in flight and 120 per minute, across all tables.
   - Player action-input gate calls: 1 in-flight slot and 80 calls per minute, reserved. Chat never uses them.
   - DM output gating: unchanged, 1 in-flight slot and 40 calls per minute, reserved. Chat and action input never use them.
   - The per-table limit of ADR-029 §8 is unchanged: at most 120 chat gate calls per minute for one table, chat gate calls only.
   - A call refused for capacity returns a typed result `limited` that names its class. A chat call that gets `limited` is rejected with the neutral busy response and is not attributable for the automatic mute. An action-input call that gets `limited` fails closed with a neutral, retryable busy response. It is not an allow and it is not attributable for the automatic mute.
4. **Judge call timeout and abort (amends ADR-029 §1.4 and §7).** A judge call times out after 4.5 s, so the whole gate (checks, judge call, and commit step) fits the 5 s of gate time per message. An aborted call keeps its in-flight slot until the upstream request settles, not until the awaiting caller sees a rejection. An upstream that ignores the abort holds the slot for at most 10 s. At 10 s the slot is released and the call is counted as lost, with no verdict. This replaces the statement in ADR-029 §8 that the in-flight slot is released on a timeout abort.

## Alternatives considered

- **Keep one shared pool.** Rejected: a chat flood across tables can use all of it, and then player actions fail closed.
- **A larger shared pool.** Rejected: the endpoint capacity is fixed, so a larger pool only moves the point at which the flood starves actions.
- **Edit ADR-029.** Rejected: ADR-029 is merged and append-only.

## Consequences

- Chat has less judge capacity than ADR-029 §8 allowed. A chat flood can no longer stall player actions.
- The allocation values (2 and 120 for chat, 1 and 80 for actions) are starting values, tunable by a later amendment.

## Verification

- Docs-only change: one file, `docs/adr/032-adr-029-amendments.md`. No existing ADR is edited.
- Citations to be checked by the reviewers against ADR-029 §1.4, §5, §7, §8, ADR-030 §2.3, and ADR-031 §3.5 and §4.7.
- Tests for the allocation and the timeout live in PR #266: an action call gets a slot while chat is saturated; output calls always pass direction `output`; a `limited` result fails closed for actions and never reaches the verdict parser; an aborted call keeps its slot until the upstream settles, up to the 10 s cap, shown with an adapter whose request settles late; the DM-output class mapping is tested through the production wrapper; the verdict parser is shown by a spy never to receive a capacity result.
