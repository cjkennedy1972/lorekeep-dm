# ADR-004: Pure deterministic rules engine; LLM proposes via typed tool calls

Status: Proposed (default) · Date: 2026-10-06

**Context.** Spec §7.1: the LLM must never be the source of truth for any numeric or state outcome. Research §3: function-calling + engine validation is the best-evidenced pattern.

**Decision.**
- `rules-engine` is a pure module: `apply(state, command, rng) -> {events, state'}`. No I/O, clock, or LLM.
- The LLM sees only typed tools (check, save, attack, cast_spell, start_combat, grant_item, update_quest, upsert_npc, ...). Args reference catalog/session IDs, never free-text names. No raw dice or "set value" tool exists.
- Illegal proposals return `{error, hint}`; 2 retries, then a safe narrated fallback with no state change.
- Dice: per-turn seed from OS CSPRNG, logged, drives a deterministic PRNG (replayable).
- Monster turns in combat are chosen by an engine monster policy (with map pathfinding, ADR-018); the LLM only narrates.
- Map-aware tools reference entities/features/markers by ID or engine-issued `optionId`; the LLM never supplies coordinates (ADR-018).
- Tool-call reliability varies by model; ADR-013 defines native, json-schema, prompt-json, and engine-assist modes over this same tool contract.

**Alternatives.** LLM "agentic referee" holding adjudication authority (cheaper to build, drifts; rejected). Rules text via RAG only (non-deterministic; used only for `rules_lookup` edge cases).

**Consequences.** Large engine build (M1), but testable and cheap at runtime. Tool set is the main product-evolution surface.

**Needs human?** No.
