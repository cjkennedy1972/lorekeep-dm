# ADR-016: Mature content on by default; any player can opt out; per-player lines and pause; hard floor unchanged

Status: Proposed (human decision 2026-10-06, round 3; supersedes round 2 "off by default, host opt-in") · Date: 2026-10-06 · Amends ADR-007

**Context.** All accounts are 18+ (ADR-015), so no age predicate or verified-adult check is needed. Round 3: mature content is acceptable by default unless a player at the table opts out. It is not explicit: innuendo and allusion are fine. The hard floor (no sexual content involving minors, plus other non-configurable blocks) is unchanged.

**Decision.**
- **Content tiers:** `family | standard | mature`. `mature` means graphic violence, dark themes, strong language, innuendo/allusion. Explicit sexual content is out of scope at every tier. Which mature prompts are usable is also bounded by the configured endpoint's acceptable-use rules.
- **Per-player opt-out:** each account has `matureOptOut` (default false). Players see content settings and can opt out at join (join screen) and at any time in session settings.
- **Table-content predicate (server-computed, never from text or the LLM):** `tableTier = mature` iff the session's base tier allows it, `moderationVerified` holds (ADR-013), the endpoint probe flag `endpoint_allows_mature` is true, and **no seated player has `matureOptOut`**. Otherwise `tableTier = standard` (or the host-chosen lower tier, `family`). Host can still lower the tier; the host cannot override a player's opt-out.
- **Live re-evaluation:** the predicate is recomputed at each round open and before every narration (join, leave, seat change, and mid-session opt-out/opt-in toggles all count). A change emits `ContentTierChanged` and a neutral banner; the prompt's session safety block is rebuilt, so the mature clause appears only while the predicate holds.
- **Per-player lines/veils and pause/X-card:** apply at every tier; they feed the session block as constraints (shared narration, so the strictest active line applies).
- **Host transfer:** tier and player settings are session/account state, not host state; nothing resets or changes when the host changes. The default carries over.
- **Endpoint refusal / degrade:** operator probe flag `endpoint_allows_mature` (ADR-013) is set at capability probe. If an endpoint refuses mature prompts at runtime (refusal or policy error), the Room falls back to `standard` for that turn, sets the flag false for the endpoint, and shows a neutral notice. It never errors the turn.
- **Hard floor:** deterministic rules plus classifier at every tier: sexual content involving minors (any character under 18 or of ambiguous age), real-person defamation/harm, instructions for real-world harm. Not configurable; opt-ins and defaults never override it.
- **Prompt and evals:** the safety block carries the computed tier and the lines/veils; the mature clause is absent when the predicate fails. Eval and red-team cases (ADR-012): opt-out at join and mid-session flips tier on the next narration; opt-out cannot be reversed by text or by the host; a late joiner's opt-out takes effect before the next narration; host transfer preserves tier; endpoint refusal degrades to `standard`; hard floor holds at `mature`.

**Alternatives.** Off by default with host opt-in (round 2, superseded). One global policy (blocks adult dark fantasy). Per-player narration tiers (the LLM cannot split narration per reader).

**Consequences.** No verifier vendor and no mixed-age predicate. Opt-out is live, so the predicate runs on the hot path (a cheap server-side check). Red-team set gains tier and opt-out dimensions (M3).

**Needs human?** Confirm the chosen endpoint's provider acceptable-use rules permit the mature tier (the probe flag handles the runtime case). Explicit sexual content stays out unless the human reverses it.
