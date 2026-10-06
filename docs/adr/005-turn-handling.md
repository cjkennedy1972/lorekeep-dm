# ADR-005: Collect-then-resolve rounds; engine-owned initiative; autopilot for away PCs

Status: Proposed (default). **Positioning decision superseded by ADR-018** (tactical map replaces range bands; human decision 2026-10-06) · Date: 2026-10-06

**Context.** Spec §6: fair multiplayer input, one in-flight DM turn, strict combat order, away players. (v0.1 also assumed no grid; superseded, see ADR-018.)

**Decision.**
- Exploration: open a round, collect one editable action per active player; close on all-in, timer (120 s party default), or host "Resolve now". Inputs during generation are queued into the next round.
- Combat: engine rolls initiative and owns order; only the active combatant acts; 15 s reaction prompts; 90 s turn timer → Dodge.
- Away > 30 s: excluded from quorum; defensive autopilot is a pure engine function (no LLM).
- Positioning: tactical grid map owned by the rules engine (ADR-018). Movement is a path command; opportunity attacks use the same 15 s reaction window. Players act by map clicks/keyboard (structured commands) or free text mapped to tools; the LLM narrates once per turn.
- Free-flow mode is P1 and reuses the same Room with a 5 s debounce.

**Alternatives.** Free-flow only (chaotic with 6 players). Range bands / theater-of-mind (v0.1 default, replaced by the map).

**Consequences.** Predictable cost (one LLM turn per round). Slower pace for large parties, mitigated by timers and Resolve-now.

**Needs human?** Q5 is closed (map). Confirm autopilot vs vote (Q7). Autopilot now includes "move to nearest cover" via engine pathing.
