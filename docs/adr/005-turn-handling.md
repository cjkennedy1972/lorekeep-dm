# ADR-005: Collect-then-resolve rounds; engine-owned initiative; theater-of-mind with autopilot for away PCs

Status: Proposed (default) · Date: 2026-10-06

**Context.** Spec §6: fair multiplayer input, one in-flight DM turn, strict combat order, no grid, away players.

**Decision.**
- Exploration: open a round, collect one editable action per active player; close on all-in, timer (120 s party default), or host "Resolve now". Inputs during generation are queued into the next round.
- Combat: engine rolls initiative and owns order; only the active combatant acts; 15 s reaction prompts; 90 s turn timer → Dodge.
- Away > 30 s: excluded from quorum; defensive autopilot is a pure engine function (no LLM).
- Positioning: range bands (`engaged/near/far`), no grid.
- Free-flow mode is P1 and reuses the same Room with a 5 s debounce.

**Alternatives.** Free-flow only (chaotic with 6 players); grid combat (scope, deferred).

**Consequences.** Predictable cost (one LLM turn per round). Slower pace for large parties, mitigated by timers and Resolve-now.

**Needs human?** Confirm: theater-of-mind (Q5) and autopilot vs vote (Q7).
