# ADR-033: Combat turn and reaction orchestration in the Room

Status: Proposed (draft PR for Atlas review) · Date: 2026-10-22 · Owner: Sage · Work item: M4 item 6 (`docs/plan/m4-breakdown.md`) · Depends on: ADR-002, ADR-003, ADR-005, ADR-018, ADR-022, ADR-029 (§§1, 4, 5, 7, 11; round lifecycle §§2–3), ADR-030, ADR-031, ADR-032

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
- ADR-029 §1 serializes all Room commands in one mailbox (ADR-002). §5 pauses at the next generation. §11 keeps chat out of DM prompts.
- ADR-030 forbids rest votes during combat.
- PR #268 (ADR-029 §§2–4 round lifecycle) is in flight. This ADR relies on those sections as they stand on this branch. If #268 changes them, the cross-references in §8 need a re-check.

## Decision

### 1. Combat state and turn ownership

The Room holds one combat state per encounter. It has three parts:

- `order`: the initiative list the engine rolls at encounter start (ADR-005). It is fixed for the encounter. Joiners are added at the next round boundary (spec §6.4).
- `turn`: `{turnId, entityId, controllerSeat, phase, timer}`.
- `phase`: one of `awaiting-command`, `moving`, `reaction-pending`, `narrating`. A table-level `paused` flag overlays every phase (§8).

Command admission in combat:

1. The active combatant's controlling seat may submit move, action, bonus action, and `end-turn`. These are accepted only in `awaiting-command`.
2. Any other seat that submits a turn command receives `not-your-turn` (US-B2 AC1). It is not queued.
3. A reaction answer (§3) is accepted only from the controlling seat of the reacting entity, in `reaction-pending`.
4. OOC chat is accepted from all seats under ADR-029 §§6–7. It does not affect phase, timers, or turn order, and it is not in the combat log.
5. Rest votes cannot open during combat (ADR-030). Exploration round submissions are rejected with `combat-active`. Combat commands are never round submissions.
6. `ask_dm` is rejected with `combat-active` (Decisions D7).

### 2. Sequencing against the mailbox

1. Every combat transition runs inside the Room's serial mailbox (ADR-002, ADR-029 §1.5). Gate calls and DM calls run outside it and re-enter with their result.
2. Commands are applied in receipt order (spec §6.2). Each applied command appends its engine events to the log before the next command is read. Clients receive those events at once, before any narration (ADR-022 T2).
3. A reaction interrupt is a phase change inside the same mailbox pass as the step that caused it. The Room moves to `reaction-pending` before it reads the next command. No command from any seat is applied between the step and the prompt opening.
4. When one step produces several triggers, they open one at a time, ordered by the reactor's initiative position and then by seat id. The next opens only after the previous prompt has closed.
5. Triggers from non-movement actions use the same lifecycle (§3). The engine emits only opportunity-attack triggers in M4 (ADR-018). Other trigger types from the M1 engine use this lifecycle unchanged. This ADR adds no new trigger types.

### 3. Reaction prompt lifecycle

1. **Open.** `ReactionPromptOpened{promptId, reactorEntityId, reactorSeat, trigger, options, deadline}`. `options` are engine handles, each single-use and expiring when the window closes (ADR-022's `opt_` rule), plus `decline`. `deadline` is open + 15 s on the server monotonic clock.
2. **Who answers.** Only the controlling seat of the reacting entity, and only while that seat is `connected` or `returning` (ADR-031 §1). The host cannot answer for another seat. Autopilot never answers. Free text is not an answer.
3. **Answer.** `use{handle}` or `decline`. The first accepted answer closes the prompt. Later answers are rejected `prompt-closed`. A repeated `actionId` returns the original result (ADR-029 §3).
4. **Expiry.** At 15 s the Room emits `ReactionDeclined{cause: timeout}` and closes the prompt. No separate expiry event is emitted.
5. **Immediate decline.** If the reactor's seat is `away`, `revoked`, or `unknown` when the trigger fires, the Room emits `ReactionDeclined{cause: presence}` at once and opens no window (ADR-031 §6). A `disconnected` or `returning` reactor keeps its window.
6. **Pause.** The window freezes with its remaining time while the table is paused. Answers are rejected while paused (D4).
7. **Use.** A `use` answer resolves through the engine (ADR-002 `apply()`). The LLM does not resolve reactions. Narration of the result waits for the turn's narration (§6).

### 4. Opportunity-attack movement: pause and resume

1. A move is one path command (ADR-018). The engine computes the full path at command time and spends movement per step. Phase is `moving` until the path ends or is ended.
2. A step that departs a square threatened by an enemy's reach (ADR-018 `threatenedBy`) is applied first. The mover stands on the step's destination. The path then pauses and the trigger opens (§3). The step is not undone.
3. When every prompt from that step has closed, the engine re-checks the remaining steps against current state: each destination is unoccupied, within remaining speed (ADR-018 `reachable`), and the mover is still able to move (conscious, not restrained, not grappled, not incapacitated per the engine's condition state). This check runs whatever the outcome was, including decline, expiry, or a reaction that dropped the mover to 0 HP.
4. If every remaining step is legal, movement resumes along the original path. If any step is illegal, movement ends at the current square with `MoveEnded{reason}`.
5. Movement is never re-routed. The player sees the path they chose or a shorter one. Remaining speed is forfeited, not refunded. Movement already spent stays spent.
6. `MoveEnded.reason` is one of `complete`, `blocked`, `incapacitated`, or `timed-out`. The enum is closed; extending it needs an amendment.

### 5. Turn timer and timeout default

1. The turn timer is 90 s for party combat and off for solo (ADR-031 §7). Min and max bounds are decided in M4 item 3.
2. The timer runs only in `awaiting-command` and `moving`. It is frozen in `reaction-pending`, so one seat's reaction window never spends the active combatant's time. It is frozen while the table is paused. It does not run during `narrating`, because the next turn has not opened.
3. On expiry the engine applies the table's configured timeout action for the active combatant: `dodge` (default) or `hold` (host-configured per table, ADR-031 §5). If the engine rejects Dodge for that turn, it applies hold. No movement is applied on expiry. Movement already taken stays.
4. Expiry emits `TurnTimedOut{turnId, entityId, action}` and then the applied action's normal events with `source: timeout`. This is not an `AutopilotActed` event (ADR-031 §5.6).
5. Timeout applies whether the controlling seat is connected or away. An away controller's turn starts under autopilot (ADR-031 §5.2), so timeout only matters if the seat went away mid-turn.

### 6. Turn resolution and the single narration

1. A turn resolves on the first of: `end-turn` from the controlling seat; timeout (§5); autopilot's turn-start action (ADR-031 §5), which resolves the turn at once; or the engine ending the turn because the combatant is incapacitated with no further action.
2. On resolution the engine appends `TurnResolved{turnId, entityId, eventIds}`, and phase moves to `narrating`. This starts exactly one DM turn (ADR-022). Its input is the turn's engine events from the allowlist in §8.
3. **One narration per resolved turn.** Every command, step, reaction, and timeout inside a turn emits events only. None of them starts a DM turn. A test must show that a turn with N commands produces one DM turn.
4. A turn with no player-visible event, such as a hold, still gets its one narration under ADR-022 T6 (D14).
5. While `narrating`, combat commands from every seat are rejected with `narrating`. They are not queued (D2). Pause is accepted and takes effect after the narration commits (ADR-029 §5).
6. On `NarrationCommitted{turnId, narrationId}` the engine advances initiative and emits `TurnOpened{turnId, entityId, deadline}` for the next combatant. If the narration fails, the ADR-022 §4.2 fallback is the narration. The turn still counts as resolved, and the next turn opens after the fallback commits.
7. The combat narration turn exposes read-only tools only (D8). Mechanics are already applied by the engine, so the narration cannot write state (ADR-022 T5).

### 7. Persistence and replay

1. Combat events are appended to the Room log (ADR-003) in mailbox order. New event types, declared under architecture §15.6: `CombatStarted`, `CombatEnded`, `TurnOpened`, `TurnTimedOut`, `TurnResolved`, `MoveStarted`, `MoveEnded`, `ReactionPromptOpened`, `ReactionAnswered`, `ReactionDeclined`, `NarrationCommitted`.
2. The snapshot holds the combat state: `order`, `turn`, `phase`, any open prompt, and the remaining time of each frozen clock. Deadlines are absolute only while a clock runs. A frozen clock is stored as remaining milliseconds.
3. Reconnect replay returns committed combat events and the current snapshot. Chat is excluded from combat replay (ADR-029 §6).
4. **Restart.** Restart puts every seat in `unknown`, which pauses the table (ADR-031 §4.7). When the table resumes:
   - An open reaction prompt is closed as `ReactionDeclined{cause: restart}`. Monotonic deadlines are not durable.
   - The movement re-check (§4.3) runs for any paused path.
   - A turn that was `awaiting-command` resumes with its stored remaining time.
   - A `TurnResolved` with no `NarrationCommitted` re-runs its narration once. The `turnId` makes the re-run idempotent. A committed narration is never re-run.

### 8. Interaction with other ADRs

- **Pause (ADR-029 §5, ADR-031 §4.7, ADR-032).** A pause freezes the turn timer and reaction windows. It opens no new turn. An in-flight narration completes first. Presence clocks keep running so that a returning seat can auto-resume the table (ADR-031 §4.7).
- **Away and autopilot (ADR-031).** Autopilot acts only at turn start (§5). Away reactors are declined at once (§3.5). Timeout on an away seat is Dodge.
- **Rest votes (ADR-030).** No vote opens during combat. This ADR does not change what happens to a vote already open when combat begins. That needs ADR-030's own rules, which this ADR did not re-read (see Verification).
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
- **Accept free-text reaction answers through the action gate.** Rejected. Judge latency would run inside the 15 s window, and an LLM mapping text to reactions would break engine authority (ADR-004).
- **Template narration for turns with no visible event.** Considered and rejected. It would make some turns' narration non-DM, which splits the one-narration rule. The cost is one DM turn per hold (D14).

## Consequences

- Each resolved turn costs one DM turn, and the next turn waits for its narration. Players see the outcome before they act. The cost is pacing; the 90 s timer keeps the wait bounded.
- Reactions never block indefinitely: the 15 s window and the frozen turn timer bound every wait.
- Presence interacts with combat only through the rules in §3.5, §5.2, and §8.
- Tests required in M4 item 6: one DM turn per resolved turn; reaction answer by controlling seat only; expiry and presence decline at the exact times; movement re-check after a reaction; timer frozen during reaction and pause; restart re-runs an uncommitted narration once and never re-runs a committed one; chat never reaches the combat DM input.

## Decisions made

- **D1.** The turn is the unit of narration. Each resolved turn gets exactly one DM turn.
- **D2.** During `narrating`, combat commands are rejected, not queued. The next turn opens only after narration commits.
- **D3.** Only the reacting entity's controlling seat answers a reaction. The host and autopilot never answer. Free text is not an answer.
- **D4.** Reaction windows and the turn timer freeze on pause. Answers are rejected while paused.
- **D5.** A blocked resumed path ends where it stands. It is not re-routed and remaining speed is forfeited.
- **D6.** Timer expiry applies the table's configured action: Dodge by default, or hold. If Dodge is rejected, hold applies.
- **D7.** `ask_dm` is rejected in combat with `combat-active`. OOC chat is the channel during combat.
- **D8.** Combat narration turns get read-only tools only.
- **D9.** On restart, open prompts close as declined, movement is re-checked, and an uncommitted narration re-runs once.
- **D10.** Several triggers from one step open one at a time, ordered by reactor initiative and then seat id.
- **D11.** Expiry is recorded as `ReactionDeclined{cause: timeout}`, not as a separate event. This keeps the event set smaller.
- **D12.** No rest vote opens during combat.
- **D13.** Host reassignment stays out of M4. The host cannot act for other seats in combat.
- **D14.** Every resolved turn gets a DM narration, including holds. ADR-022 T6 applies unchanged.

## Verification

- Docs-only change: one new file, `docs/adr/033-combat-reactions.md`. No existing ADR or `docs/architecture.md` is edited. No code is written.
- Sources read: `docs/spec.md` §6.2–§6.5, US-B2 AC1–AC2, the opportunity-attack criterion at line 187; `docs/plan/m4-breakdown.md` item 6; ADR-005, ADR-018 (path, reach, handles), ADR-022 (T1–T6 table, tool boundaries), ADR-029 (§§1–7, §11), ADR-030 (the "no vote during combat" rule), ADR-031 (§§1–7), ADR-032 (scope only).
- Not verified:
  - PR #268 contents. §§2–4 are cited as they stand on this branch.
  - Full ADR-030 text on votes that are already open when combat begins. §8 leaves that unchanged.
  - Full ADR-032 text on pause mechanics. §8 relies on ADR-029 §5 and ADR-031 §4.7 for pause.
  - The M1 engine's current list of trigger types. §2.5 assumes only opportunity attacks are emitted in M4.
- Prettier is run on this file before commit (see the PR for the command and result).
