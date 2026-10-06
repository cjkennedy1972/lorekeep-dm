# ADR-006: Tiered memory with a tool-written registry; Postgres FTS, no vector store at launch

Status: Proposed (default) · Date: 2026-10-06

**Context.** R-M1..M3: consistent NPCs/places across sessions within a ~3k-token dynamic context budget.

**Decision.**
1. Cached static prefix (persona, safety, tools, rules cheat-sheet).
2. Session block (settings, party, premise, scene summary), cached, changes at scene boundaries.
3. Dynamic: state projection, registry facts for entities named in inputs/last turn (deterministic name/alias scan), last ~6 turns verbatim.
4. Retrieved: top-k summaries/registry entries via Postgres full-text + trigram.
Registry is written through tools (not inferred from prose). Scene summaries are written by the cheap tier at scene close, append-only, rebuildable from the event log.

**Alternatives.** Vector DB from day one (extra infra; entity-name matching covers most cases); rolling summary only (drift, per AI Dungeon).

**Consequences.** Add `pgvector` only if the US-E3 consistency eval fails.

**Needs human?** No.
