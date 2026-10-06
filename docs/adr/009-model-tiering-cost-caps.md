# ADR-009: Tiered models, one call per turn, per-session cost meter; prompt caching optional

Status: Proposed (default). **Revised 2026-10-06** for configurable endpoints (ADR-013): provider is no longer Anthropic by default and caching is no longer assumed · Date: 2026-10-06

**Context.** Default budgets (operator-configurable, **not product requirements**): <= $1.50 per party session (2 h, 150 turns), <= $0.60 per solo hour; target first token <= 2.5 s. Endpoints are operator-configured per tier (`fast`, `frontier`) and may be hosted or local (ADR-013). Prices below are a **reference profile** (research §5: fast-tier $1/$5 and frontier-tier $2/$10 per M tokens; cache reads 0.1x) and must be replaced by the operator's `pricing` config.

**Decision.**
- Roles map to tiers by config. Routine turns and summaries/classification on `fast` (~85%); key scenes (openers, bosses, recaps) on `frontier` (~15%).
- One LLM call per turn with an in-call tool loop (max 3 iterations). Combat uses structured UI commands; the LLM narrates once per turn, not once per command. Tool schemas are sent per mode (exploration vs combat) to keep the prefix small.
- Prompt layout stays byte-stable (static prefix, then session block, then dynamic). **Caching is optional:** when `cachePolicy` is `auto` or `explicit` and the endpoint supports it, hits reduce cost; the budget is validated **without** caching.
- Cost meter reads usage from every call and prices it from the endpoint's `pricing` (zero or amortized for local models). 80% -> all `fast` + shorter narration; 100% -> wrap-up (spec §9.2).
- **Estimates (assumptions, unmeasured; see architecture §9.2):** cached reference ~$1.3 party; **uncached ~$1.8-2.2 party and ~$0.8-0.9 per solo hour, above both caps.**

**Alternatives.** Frontier-only (≈ 2x+ over cap). Two fixed calls per turn (≈ 2x). Assume caching (rejected: not available on all endpoints).

**Consequences.** With no caching the original caps are not met at the reference prices. Options: raise caps, shrink context, lower frontier share, or use a cheaper/local fast tier. Local models trade API cost for GPU cost and latency risk (first-token SLO applies only to the reference configuration).

**Needs human?** **Yes:** default budget values and the reference endpoint (Q2).
