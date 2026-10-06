# ADR-016: Mature content off by default; host opt-in per table; per-player settings and pause; hard floor unchanged

Status: Proposed (human decision 2026-10-06, round 2) · Date: 2026-10-06 · Amends ADR-007

**Context.** All accounts are 18+ (ADR-015), so no age predicate or verified-adult check is needed. Mature content is still opt-in. The hard floor (no sexual content involving minors, plus other non-configurable blocks) is unchanged.

**Decision.**
- **Content tiers:** `family | standard | mature`. Default `standard`; `mature` is **off by default**. `mature` means graphic violence, dark themes, strong language. Explicit sexual content is not part of `mature` in this design (assumption, flagged).
- **Host opt-in per table:** only the host can enable `mature` for a session, written server-side as the session `contentTier`. Text and the LLM cannot flip it. The mature clause appears in the prompt only when enabled; classifier rubrics are tier-specific.
- **Per-player content settings:** each player may set personal lines/veils and can pause or use the X-card at any time at every tier; these feed the session block as constraints (the narration stays shared, so the strictest active line applies). Players who are not comfortable with `mature` can leave or ask the host to lower the tier; a tier change emits `ContentTierChanged` and a neutral banner.
- **Moderation endpoint gate:** mature stays unavailable unless the configured `moderate` endpoint has passed the red-team set (`moderationVerified`, ADR-013).
- **Hard floor:** deterministic rules plus classifier at every tier: sexual content involving minors (any character under 18 or of ambiguous age), real-person defamation/harm, instructions for real-world harm. Not configurable, not overridden by mature.

**Alternatives.** One global policy (blocks adult dark fantasy). Per-player narration tiers (the LLM cannot split narration per reader).

**Consequences.** No verifier vendor, no mixed-age predicate; simpler than the earlier design (about -0.5 wk). Red-team set still grows a tier dimension (M3).

**Needs human?** Confirm explicit sexual content stays out; confirm the chosen endpoint's provider AUP permits `mature` (otherwise the tier stays off).
