# ADR-009: Provider abstraction, tiered models, cache-friendly prompts, per-session cost meter

Status: Proposed (default) · Date: 2026-10-06

**Context.** Targets: ≤ $1.50 per party session (2 h, 150 turns), ≤ $0.60 per solo hour; first token ≤ 2.5 s. Research prices: Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10 per M tokens, cache reads 0.1×/0.1×.

**Decision.**
- Provider-abstracted client with roles `narrate`, `classify`, `summarize`; Anthropic default.
- Routine turns on Haiku-tier (~85%), key scenes (openers, bosses, recaps) on Sonnet-tier (~15%). Summaries/moderation on the cheap tier.
- One LLM call per turn with an in-call tool loop (max 3 iterations). Byte-stable cached prefix; dynamic context ≤ 3k tokens.
- Per-session cost meter from provider usage; 80% → all cheap tier + shorter narration; 100% → wrap-up mode (spec §9.2).
- Estimate: ≈ $1.3 party / ≈ $0.5 solo-hour, margins thin, **unmeasured**.

**Alternatives.** Sonnet-only (≈ $2.5+ per party session, over cap); two fixed calls per turn (≈ 2× cost).

**Consequences.** Prompt discipline is a first-class concern; cache TTL (5 min) vs slow party rounds needs measurement.

**Needs human?** **Yes**: provider choice and budget ceiling (Q2).
