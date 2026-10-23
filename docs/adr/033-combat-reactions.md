# ADR-033: Combat turn and reaction orchestration in the Room

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-22 · Owner: Sage · Work item: M4 item 6 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-018, ADR-022, ADR-029 (§§1, 4, 5, 7, 8, 11; round lifecycle §§2–3), ADR-030, ADR-031, ADR-032

Append-only: this ADR adds contracts. It does not edit ADR-001 through ADR-032 or `docs/architecture.md`. Its event types are declared as additions to the v0.2 event list in architecture §15.6, as ADR-031 does.

## Context

- Spec §6.3: strict initiative order. Only the active player acts and moves its token. Reactions, including opportunity attacks, interrupt through an explicit prompt with a 15 s window that auto-declines on expiry.
- Spec US-B2 AC1: a non-active player who submits gets "not your turn", plus a reaction prompt when one triggers. AC2: a turn timer (90 s party, off solo, host-configurable) expires into Dodge or hold.
- Spec §6.2: map moves in combat are accepted only from the active combatant and applied by the engine in receipt order.
- Spec opportunity-attack criterion (line 187): leaving an enemy's reach triggers a 15 s prompt through the engine, never through LLM discretion.
- ADR-005 (Proposed) sets 15 s reaction prompts and a 90 s turn timer that resolves to Dodge. It does not say how a reaction interrupts a turn, what persists, or when the narration runs. This ADR decides those.
- ADR-018: movement is one multi-step path command. The engine owns geometry (`reachable`, `path`, `threatenedBy`). The LLM never supplies coordinates; it uses engine-issued handles.
- ADR-022: one narration per turn (T1), roll and state events before narration (T2), at most 8 tool calls (T3), the engine's `apply()` is the only writer (T5), 60–180 words (T6), and fallback narration on failure (§4.2).
- ADR-031 gives presence states, the 10 s hold, autopilot as Dodge or hold only at turn start (§5), and a pause that freezes game timers but not presence clocks (§4.7).
- ADR-029 §1 serializes all Room commands in one mailbox (ADR-002). §5 pauses at the next generation. §7 re-checks ticket, seat, and revocation on every send. §8 sets per-seat rate buckets. §11 keeps chat out of DM prompts.
- ADR-030 forbids rest votes during combat.
- PR #268 (ADR-029 §§2–4 round lifecycle) is in flight. This ADR relies on those sections as they stand on this branch. If #268 changes them, the cross-references in §8 need a re-check.

## Decision

### 1. Combat state and turn ownership

The Room holds one combat state per encounter. It has three parts:

- `order`: the initiative list the engine rolls at encounter start (ADR-005). It is fixed for the encounter. Joiners are added at the next round boundary (spec §6.4).
- `turn`: `{turnId, entityId, controllerSeat, phase, timer}`. `controllerSeat` is null for NPC and unassigned entities.
- `phase`: one of `awaiting-command`, `moving`, `reaction-pending`, `narrating`. A table-level `paused` flag overlays every phase (§8).

Command admission in combat is defined once, by phase. This table is the only admission rule. §4 and §6 refer to it.

| Phase | Accepted | Rejected |
|---|---|---|
| `awaiting-command` | Controlling seat: move, action, bonus action, `end-turn`. | Other seats: `not-your-turn`. Chat is always allowed (item 4). |
| `moving` (a path resolving) | Nothing from the controlling seat. Engine-driven continuation only: the path runs to its end or to a §4 stop, and the bounded-resolution paths (§5.5) and timer expiry (§5.3) apply. | Controlling seat: move, action, bonus action, `end-turn` → `move-in-progress`. Not queued. |
| `reaction-pending` | The controlling seat of the reacting entity: `use{handle}` or `decline` (§3). The bounded-resolution paths (§5.5) and timer expiry (§5.3) still apply. | Every other command → `reaction-pending`. Not queued. |
| `narrating` | Nothing from any seat, except pause (ADR-029 §5). | Every combat command → `narrating`. Not queued (D2). |

The phase name is `narrating` throughout. ADR-022 calls it the narration turn.

Admission rules:

1. The active combatant's controlling seat's turn commands are accepted only in `awaiting-command`, as the table shows.
2. Any other seat that submits a turn command receives `not-your-turn` (US-B2 AC1). It is not queued.
3. A reaction answer (§3) is accepted only from the controlling seat of the reacting entity, in `reaction-pending`.
4. OOC chat is accepted from all seats under ADR-029 §§6–7. It does not affect phase, timers, or turn order, and it is not in the combat log.
5. Rest votes cannot open during combat (ADR-030). Exploration round submissions are rejected with `combat-active`. Combat commands are never round submissions.
6. `ask_dm` is rejected with `combat-active` (D7).
7. **Seat identity is server-side.** The acting seat is derived from the authenticated socket and its ADR-029 §7 ticket. Any seat field in a payload is ignored, or rejected as `seat-mismatch` if it disagrees with the socket. Every combat command, including `end-turn` and reaction answers, re-runs the ADR-029 §7 checks: ticket valid, seat current, seat not revoked. A `revoked` seat is rejected on every combat command.

### 2. Sequencing against the mailbox

1. Every combat transition runs inside the Room's serial mailbox (ADR-002, ADR-029 §1.5). Gate calls and DM calls run outside it and re-enter with their result.
2. Commands are applied in receipt order (spec §6.2). Each applied command appends its engine events to the log before the next command is read. Clients receive those events at once, before any narration (ADR-022 T2).
3. A reaction interrupt is a phase change inside the same mailbox pass as the step that caused it. The Room moves to `reaction-pending` before it reads the next command. No command from any seat is applied between the step and the prompt opening.
4. When one step produces several triggers, they open one at a time, ordered by the reactor's initiative position and then by seat id. The next opens only after the previous prompt has closed.
5. Triggers from non-movement actions use the same lifecycle (§3). The engine emits only opportunity-attack triggers in M4 (ADR-018). Other trigger types from the M1 engine use this lifecycle unchanged. This ADR adds no new trigger types.

### 3. Reaction prompt lifecycle

1. **Open.** `ReactionPromptOpened{promptId, reactorEntityId, reactorSeat, deadline}` is broadcast to all seats. It carries no trigger detail and no options. `deadline` is open + 15 s on the server monotonic clock.
2. **Private payload.** The controlling seat alone receives `{trigger, options}` for the prompt, sent as a separate private message. `options` are engine handles bound to `(promptId, reactorSeat)`. Each is single-use and expires when the window closes (ADR-022's `opt_` rule), plus `decline`. A handle presented by any other seat, or for another prompt, is rejected. Other seats see only "prompt open" and its deadline. Snapshots (§7.2) and replays (§7.3) follow the same split.
3. **Who answers.** Only the controlling seat of the reacting entity, and only while that seat is `connected` or `returning` (ADR-031 §1). The host cannot answer for another seat. Autopilot never answers. Free text is not an answer.
4. **Answer.** `use{handle}` or `decline`. The first accepted answer closes the prompt. Later answers are rejected `prompt-closed`. A repeated `actionId` returns the original result, keyed by `(seat, actionId)` (ADR-029 §3, §4).
5. **Expiry.** At 15 s the Room emits `ReactionDeclined{cause: timeout}` and closes the prompt. No separate expiry event is emitted.
6. **Immediate decline.** The Room emits `ReactionDeclined` at once and opens no window in these cases:
   - `cause: presence`: the reactor's seat is `away`, `revoked`, or `unknown` when the trigger fires (ADR-031 §6). A `disconnected` or `returning` reactor keeps its window.
   - `cause: no-controller`: the reacting entity has `controllerSeat` null (an NPC or unassigned entity). No seat answers for it. This ADR does not give the host or any other seat authority over NPC reactions. Decline is the only fail-closed default. A null controller is never treated as a match.
   - `cause: cap`: the turn's reaction-wait cap is spent (§3.8).
7. **Pause.** The window freezes with its remaining time while the table is paused. Answers are rejected while paused (D4).
8. **Per-turn reaction-wait cap.** Each turn has a cumulative reaction-wait budget of 45 s, which is three full 15 s windows. Only time a window is actually open counts against it; time frozen by pause does not. When the budget is spent, further triggers in that turn are declined with `cause: cap` and open no window. Together with §5.2, this bounds a turn to at most 90 s of active-player time plus 45 s of reaction time.
9. **Use.** A `use` answer resolves through the engine (ADR-002 `apply()`). The LLM does not resolve reactions. Narration of the result waits for the turn's narration (§6).

### 4. Opportunity-attack movement: pause and resume

1. A move is one path command (ADR-018). The engine computes the full path at command time and spends movement per step. Phase is `moving` until the path ends. No command from the controlling seat is accepted while moving (admission table, §1). The path cannot be ended by the player.
2. A step that departs a square threatened by an enemy's reach (ADR-018 `threatenedBy`) is applied first. The mover stands on the step's destination. The path then pauses and the trigger opens (§3). The step is not undone.
3. When every prompt from that step has closed, the engine re-checks the remaining steps against current state: each destination is unoccupied, within remaining speed (ADR-018 `reachable`), and the mover is still able to move (conscious, not restrained, not grappled, not incapacitated per the engine's condition state). This check runs whatever the outcome was, including decline, expiry, cap, or a reaction that dropped the mover to 0 HP.
4. If every remaining step is legal, movement resumes along the original path and phase returns to `moving`. If any step is illegal, movement ends at the current square with `MoveEnded{reason}`.
5. Movement is never re-routed. The player sees the path they chose or a shorter one. Remaining speed is forfeited, not refunded. Movement already spent stays spent.
6. `MoveEnded.reason` is one of `complete`, `blocked`, `incapacitated`, or `timed-out`. The enum is closed; extending it needs an amendment.

### 5. Turn timer, timeout, and bounded resolution

1. The turn timer is 90 s for party combat and off for solo (ADR-031 §7). The host may configure it, but a configured value below **30 s** is rejected, so no table can churn turns on near-zero timers. The upper bound is decided in M4 item 3.
2. The timer runs only in `awaiting-command` and `moving`. It is frozen in `reaction-pending`, so one seat's reaction window never spends the active combatant's time. It is frozen while the table is paused. It does not run during `narrating`, because the next turn has not opened.
3. On expiry the engine applies the table's configured timeout action for the active combatant: `dodge` (default) or `hold` (host-configured per table, ADR-031 §5). If the engine rejects Dodge for that turn, it applies hold. If the engine rejects hold too, it ends the turn with no action and still narrates (§6.4). No movement is applied on expiry. Movement already taken stays.
4. Expiry emits `TurnTimedOut{turnId, entityId, action}` and then the applied action's normal events with `source: timeout`. This is not an `AutopilotActed` event (ADR-031 §5.6).
5. **Bounded resolution regardless of timer setting.** A solo table has its timer off, so the timer alone cannot end a turn whose controller stops responding. The following applies in `awaiting-command` and `moving`, whatever the timer setting:
   - Controller `revoked`: the turn resolves at once with the timeout action (§5.3). A revoked seat cannot act (ADR-029 §7), so waiting gains nothing.
   - Controller `away` or `unknown`: a fixed 90 s bound starts when the seat's presence changes to that state. If the seat has not returned or acted by then, the turn resolves with the timeout action. The bound is a Room constant and is not configurable.
   - Controller `connected` or `returning` with the timer off: no bound. The player chose the pace.
   The bound pauses with the table (§8), so an away seat at a paused table is not timed out.
6. An away controller's turn starts under autopilot (ADR-031 §5.2). Mid-turn departures are covered by §5.5, not by autopilot, because ADR-031 §5 acts only at turn start.

### 6. Turn resolution and the single narration

1. A turn resolves on the first of: `end-turn` from the controlling seat; timeout or bounded resolution (§5); autopilot's turn-start action (ADR-031 §5), which resolves the turn at once; or the engine ending the turn because the combatant is incapacitated with no further action.
2. On resolution the engine appends `TurnResolved{turnId, entityId, eventIds}`, and phase moves to `narrating`. This starts exactly one DM turn (ADR-022). Its input is the turn's engine events from the allowlist in §8.
3. **One narration per resolved turn.** Every command, step, reaction, and timeout inside a turn emits events only. None of them starts a DM turn. A test must show that a turn with N commands produces one DM turn.
4. A turn with no player-visible event, such as a hold or a turn ended with no action after both Dodge and hold were rejected, still gets its one narration under ADR-022 T6 (D14).
5. While `narrating`, combat commands from every seat are rejected with `narrating`. They are not queued (D2). Pause is accepted and takes effect after the narration commits (ADR-029 §5).
6. On `NarrationCommitted{turnId, narrationId}` the engine advances initiative and emits `TurnOpened{turnId, entityId, deadline}` for the next combatant. If the narration fails, the ADR-022 §4.2 fallback is the narration. The turn still counts as resolved, and the next turn opens after the fallback commits. The narration DM call has the ADR-032 60 s hard cap, so a hung call cannot freeze the table.
7. The combat narration turn exposes read-only tools only (D8). Mechanics are already applied by the engine, so the narration cannot write state (ADR-022 T5). ADR-022 sets no tool scope, so D8 is a new contract. It needs an ADR-022 amendment note to match.
8. **Input boundary.** Free text from players never reaches the combat DM input. Only engine-issued enum values, engine handles' resolved effects, and sanitized display names may. Chat is excluded (D7). ADR-022 T5 limits writes; this rule limits what enters the prompt.
9. **Output reservation.** Each turn's narration draws from the ADR-032 DM output reservation (one in flight, 40 per minute per table). Turns queue behind it and never bypass it.

### 7. Persistence and replay

1. Combat events are appended to the Room log (ADR-003) in mailbox order. New event types, declared under architecture §15.6: `CombatStarted`, `CombatEnded`, `TurnOpened`, `TurnTimedOut`, `TurnResolved`, `MoveStarted`, `MoveEnded`, `ReactionPromptOpened`, `ReactionAnswered`, `ReactionDeclined`, `NarrationCommitted`.
2. The snapshot holds the combat state: `order`, `turn`, `phase`, any open prompt (as "prompt open" for seats other than the controller, with full options only for the controller), and the remaining time of each frozen clock. Deadlines are absolute only while a clock runs. A frozen clock is stored as remaining milliseconds. The per-turn reaction-wait budget (§3.8) and the narration attempt counter (§7.4) are stored with the turn.
3. Reconnect replay returns committed combat events and the current snapshot, filtered by the visibility split in §3.2. Chat is excluded from combat replay (ADR-029 §6).
4. **Restart.** Restart puts every seat in `unknown`, which pauses the table (ADR-031 §4.7). When the table resumes:
   - An open reaction prompt is closed as `ReactionDeclined{cause: restart}`. Monotonic deadlines are not durable.
   - The movement re-check (§4.3) runs for any paused path.
   - A turn that was `awaiting-command` resumes with its stored remaining time.
   - A `TurnResolved` with no `NarrationCommitted` re-runs its narration once, as the attempt counter allows. The `turnId` makes the re-run idempotent. The turn stores `narrationAttempts`, incremented on each start. A turn with `narrationAttempts` already at 2 commits the ADR-022 §4.2 fallback instead of starting another DM call. A committed narration is never re-run.

### 8. Interaction with other ADRs

- **Pause (ADR-029 §5, ADR-031 §4.7, ADR-032).** A pause freezes the turn timer, the bounded-resolution clock (§5.5), and reaction windows. It opens no new turn. An in-flight narration completes first. Presence clocks keep running so that a returning seat can auto-resume the table (ADR-031 §4.7).
- **Away and autopilot (ADR-031).** Autopilot acts only at turn start (§5). Away reactors are declined at once (§3.6). Timeout on an away seat is Dodge, applied after the bound in §5.5.
- **Rate limits (ADR-029 §8).** Combat commands use the same per-seat buckets as other commands. No combat command is exempt. A combat command that exceeds its bucket is rejected `rate-limited` and does not change phase.
- **Idempotency (ADR-029 §3, §4).** `actionId` is keyed by `(seat, actionId)`. A seat that replays another seat's `actionId` gets its own result space and never another seat's result.
- **Rest votes (ADR-030).** This ADR amends ADR-030's "No vote during combat" line (ADR-030, the combat rule at merged line 143). The amendment, which ADR-030 needs as an append-only note:
  - Combat start cancels any open rest vote immediately, with outcome `cancelled-combat`. This is the same outcome as a failed vote under ADR-030: no rest state changes.
  - Combat start is not delayed by the vote. The cancel runs in the same mailbox pass as `CombatStarted`.
  - No vote can open until `CombatEnded`.
- **Round lifecycle (ADR-029 §§2–4, PR #268).** When an encounter starts, an open exploration round closes with `closeReason: combat-start` and resolves in one DM turn before `CombatStarted`. No round opens during combat. The accepted and queued rules of ADR-029 §4 do not apply to combat commands.
- **OOC chat (ADR-029 §§6–7, §11).** Chat works during combat, under the same gate. Chat does not affect turn order or timers. The DM allowlist gains the combat events above. Chat is never on it.
- **Geometry and movement (ADR-018).** Path, reach, and handle rules are unchanged. This ADR only adds the pause and resume points in §4.
- **Tool boundaries (ADR-022).** Combat mechanics go through the engine as structured commands. Narration turns get read-only tools (D8). The per-turn limits of T3 and T4 apply to the narration turn.

## Alternatives considered

- **Queue combat commands during narration, as ADR-029 §4 does for exploration.** Rejected. The next combatant would act on state the narration has not yet described, so the order of narration and action would break.
- **Open the next turn at once and narrate in parallel.** Rejected. The narration would describe positions that have already changed. It also breaks T2 ordering and the one-in-flight rule (spec §6.2).
- **Re-route a blocked movement to its destination.** Rejected. The player would see a path they did not choose.
- **Refund movement when a resumed path is blocked.** Rejected. It rewards a reaction hit that stopped the mover.
- **Let the host answer a reaction for an absent seat.** Rejected. The host would spend another seat's reaction.
- **Let the host or an NPC policy answer reactions for null-controller entities.** Rejected. It adds an authority path that the spec does not grant. Null-controller reactions decline (§3.6).
- **Accept free-text reaction answers through the action gate.** Rejected. Judge latency would run inside the 15 s window, and an LLM mapping text to reactions would break engine authority (ADR-004).
- **Template narration for turns with no visible event.** Considered and rejected. It would make some turns' narration non-DM, which splits the one-narration rule. The cost is one DM turn per hold (D14).
- **Leave a solo table with the timer off and no bound.** Rejected. A controller who leaves mid-turn would hold the table indefinitely. The bound in §5.5 applies only to away or revoked controllers, so a connected player keeps full control of pace.

## Consequences

- Each resolved turn costs one DM turn, and the next turn waits for its narration. Players see the outcome before they act. The cost is pacing; the 90 s timer keeps the wait bounded.
- Reactions never block indefinitely: the 15 s window, the 45 s per-turn reaction budget, and the frozen turn timer bound every wait. A turn's active-player time is bounded by 90 s, and its reaction time by 45 s.
- A turn cannot stall on an absent controller: revoked resolves at once, and away or unknown resolves after 90 s, with or without a timer.
- Presence interacts with combat only through the rules in §3.6, §5.5, and §8.
- Tests required in M4 item 6:
  - one DM turn per resolved turn, including a turn with N commands;
  - reaction answer by the controlling seat only, and handles rejected from any other seat or prompt;
  - prompt options and trigger detail absent from other seats' broadcasts, snapshots, and replays;
  - null-controller reactions declined at once with `cause: no-controller`;
  - expiry and presence decline at the exact times;
  - the 45 s reaction budget, after which further triggers decline with `cause: cap`;
  - a server-side seat derived from the socket, with a mismatched payload seat rejected;
  - movement re-check after a reaction;
  - timer frozen during reaction and pause;
  - `move-in-progress` rejects move, action, and `end-turn` while phase is `moving`, and timer expiry ends the path with `timed-out`;
  - a rest vote open at `CombatStarted` is cancelled in the same mailbox pass, with outcome `cancelled-combat`, and combat start is not delayed;
  - revoked controller resolves at once, and away controller resolves after 90 s with the timer off;
  - configured timer below 30 s rejected;
  - restart re-runs an uncommitted narration once, never re-runs a committed one, and commits the fallback when the attempt counter is at 2;
  - chat and free text never reach the combat DM input.

## Decisions made

- **D1.** The turn is the unit of narration. Each resolved turn gets exactly one DM turn.
- **D2.** During `narrating`, combat commands are rejected, not queued. The next turn opens only after narration commits.
- **D3.** Only the reacting entity's controlling seat answers a reaction. The host and autopilot never answer. Free text is not an answer. An entity with no controlling seat is always declined.
- **D4.** Reaction windows and the turn timer freeze on pause. Answers are rejected while paused.
- **D5.** A blocked resumed path ends where it stands. It is not re-routed and remaining speed is forfeited.
- **D6.** Timer expiry applies the table's configured action: Dodge by default, or hold. If Dodge is rejected, hold applies. If hold is rejected, the turn ends with no action and is narrated.
- **D7.** `ask_dm` is rejected in combat with `combat-active`. OOC chat is the channel during combat.
- **D8.** Combat narration turns get read-only tools only.
- **D9.** On restart, open prompts close as declined, movement is re-checked, and an uncommitted narration re-runs once, bounded by a persisted attempt counter.
- **D10.** Several triggers from one step open one at a time, ordered by reactor initiative and then seat id.
- **D11.** Expiry is recorded as `ReactionDeclined{cause: timeout}`, not as a separate event. This keeps the event set smaller.
- **D12.** No rest vote opens during combat. Combat start cancels any open rest vote immediately with outcome `cancelled-combat`, which is a failed vote under ADR-030 and changes no rest state. Combat start is not delayed by the vote. Votes reopen only after `CombatEnded`. This amends ADR-030's "No vote during combat" line.
- **D13.** Host reassignment stays out of M4. The host cannot act for other seats in combat.
- **D14.** Every resolved turn gets a DM narration, including holds. ADR-022 T6 applies unchanged.
- **D15.** The acting seat is server-side, derived from the socket and ticket. Payload seats are never trusted.
- **D16.** Reaction answers and prompt options are seat-bound. Other seats see only that a prompt is open.
- **D17.** Each turn has a 45 s cumulative reaction-wait budget. Exhausting it declines further triggers with `cause: cap`.
- **D18.** A revoked controller resolves at once. An away or unknown controller resolves after a fixed 90 s bound, regardless of the timer setting.
- **D19.** Admission is defined once, by phase, in the §1 table. While `moving`, the controlling seat's move, action, and `end-turn` are rejected with `move-in-progress`, and the only inputs honored are reaction answers when a window opens and the bounded-resolution paths (§5.3, §5.5). The player has no end-path command. A path runs to its end or to a §4 stop.
- **D20.** Combat start cancels open rest votes immediately with outcome `cancelled-combat`. No vote opens until `CombatEnded`. This amends ADR-030's "No vote during combat" line.

## Verification

- Docs-only change: one file, `docs/adr/033-combat-reactions.md`. No existing ADR or `docs/architecture.md` is edited. No code is written.
- Sources read: `docs/spec.md` §6.2–§6.5, US-B2 AC1–AC2, the opportunity-attack criterion at line 187; `docs/plan/m4-breakdown.md` item 6; ADR-005, ADR-018 (path, reach, handles), ADR-022 (T1–T6 table, tool boundaries), ADR-029 (§§1–8, §11), ADR-030 (the "no vote during combat" rule), ADR-031 (§§1–7), ADR-032 (scope only).
- Not verified:
  - PR #268 contents. §§2–4 are cited as they stand on this branch.
  - Full ADR-030 text on votes that are already open when combat begins. §8 and D12 set the rule here; ADR-030 has no matching text yet.
  - Full ADR-032 text on pause mechanics and the output reservation numbers. §§6.9 and 8 rely on the figures cited from ADR-032 scope.
  - The M1 engine's current list of trigger types. §2.5 assumes only opportunity attacks are emitted in M4.
  - The M4 item 3 upper bound on the turn timer.
- Prettier is run on this file before commit (see the PR for the command and result).
