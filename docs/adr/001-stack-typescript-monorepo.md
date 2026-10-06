# ADR-001: TypeScript monorepo (Node + Postgres + React)

Status: Proposed (default) · Date: 2026-10-06

**Context.** The valuable code is a rules engine and a room state machine. The browser also needs engine logic for character-creation validation and legal-action hints. Load is tiny (≤ 6 sockets/room, ≤ 200 sessions).

**Decision.** TypeScript everywhere. Shared packages `schema` and `rules-engine`. Server: Node + Fastify + `ws`. DB: Postgres. Frontend: React + Vite.

**Alternatives.**
- Cloudflare Durable Objects: great room fit, lock-in, unverified pricing/limits for long LLM streams, weaker SQL. Runner-up.
- Python FastAPI + React: good eval ecosystem, but the engine can't be shared with the browser (validation drift, two toolchains).

**Consequences.** One engine, no duplication. Node single-thread per node is fine at this scale. We own sticky routing (ADR-002). Revisit if ops cost of routing exceeds expectations.

**Needs human?** No.
