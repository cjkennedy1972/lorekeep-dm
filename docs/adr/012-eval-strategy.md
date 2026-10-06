# ADR-012: Deterministic tests first; recorded-LLM mode; eval gates for rules, memory, safety

Status: Proposed (default) · Date: 2026-10-06

**Context.** LLM behavior drifts; spec sets measurable targets (rules ≥ 90%, puppeting < 2%, consistency ≥ 95%, injection ≥ 95%, moderation FN ≤ 5%).

**Decision.**
- Engine, catalog, tool-contract, replay, and Room simulation tests are deterministic and block CI.
- The orchestrator supports **fixed seed + recorded/mock LLM** mode for reproducible e2e tests.
- Nightly and on prompt/model changes: live-LLM eval suites (rules Q&A, puppeting, 3-session consistency, spotlight, narration-vs-tool agreement via checks + LLM judge, red-team injection and content sets).
- Release gates use the spec A10 thresholds until the owner (Q10) changes them.

**Alternatives.** Manual playtesting only (can't catch regressions).

**Consequences.** Building eval sets is real work (starts M2, gates by M3/M5).

**Needs human?** **Yes**: name the eval owner and confirm pass thresholds (Q10).
