# Human decisions log (authoritative; newer entries override older docs)

## 2026-10-06 (round 2)
1. Rules base: SRD 5.2.1.
2. LLM: operator-configurable endpoint (OpenAI-compatible / Anthropic-style / local); no single-vendor lock-in.
3. Accounts required (replaces guest-only).
4. **Minimum age 18+ at launch** (age attestation at registration, minimal data). Parental consent and a 13-17 audience are a **later roadmap item**; keep an extension point only.
5. Mature content: off by default; host opt-in per table; per-player content settings and pause; hard floor on sexual content involving minors stays non-configurable.
6. Log retention: 30 days.
7. Combat: **2D top-down battle map with miniature tokens and terrain is the first-release view.** **3D/isometric view and importing user STL/GLB minis and 3D-printed terrain are later roadmap.**
8. Legal/compliance questions (uploaded-model IP, upload moderation, privacy-law specifics, product-name trademark) are **deferred until the project shows it is viable**. They are a parking-lot list, not milestone gates. SRD CC-BY attribution remains an MVP requirement (license compliance).

## 2026-10-06 (round 3)
1. **Mature content is the default and is acceptable unless table players opt out.** It is not explicit: innuendo and allusion are fine, subject to what the configured LLM endpoint allows. Any player opting out turns it off for the table (shared scene). Per-player lines/veils/pause remain. The hard floor on sexual content involving minors stays non-configurable. Explicit sexual content stays out of scope. Supersedes the round-2 "off by default, host opt-in" wording and the "host transfer resets to off" assumption (A28/A29 follow-ups): the default now carries over.
2. **Age attestation is a birthdate entry** at registration (18+ computed from it). Under-18 is refused and nothing is kept for them. Data minimization: store only the adult flag plus the check date unless a later need for the birthdate itself appears (architect to confirm and flag).
3. **No scope cuts.** Plan for the full scope: 12 SRD classes, adventures #1-#3, authored plus stretch procedural maps, local-model fallback modes. Timeline stays about 23 weeks as in architecture.md v0.3 section 11.

## 2026-10-06 (round 4)
1. **Age data: store only the adult flag (`is_adult`) plus check date (`age_checked_at`).** The birthdate entered at signup is used for the server-side 18+ computation and then discarded; it is never persisted. Under-18: refused, nothing stored beyond a short retry-block cookie.
2. **GO for M0** (Foundations + accounts). Process per docs/process.md: sub-task cards generated from the plan, nothing done until verified in code.

## Atlas calls (overnight, human asleep; reversible, flagged for review)
- **Model allocation (human-authorized: spread usage across OAuth-authenticated models).** Per-spawn `model` override, no config changes. forge -> openai/gpt-6-sol; proof -> openai/gpt-6-luna; sentinel (review) -> openai/gpt-6-astra (different family than author); prism/sage/compass stay anthropic/claude-sonnet-5-5; xai/* only for short jobs (OAuth expires ~5h after 02:30 EDT); OpenRouter and localai API-key providers not used (metered). If an override spawn fails, fall back to the agent default and note it here. Verification rule (docs/process.md) applies regardless of model.
- **Cost correction (human): be mindful of gpt-6-astra.** Supersedes the sentinel allocation above. sentinel -> openai/gpt-6-sol for routine review (forge uses sol too, so reviews of forge code use proof's gpt-6-luna or Claude sonnet instead to keep reviewer != author model). astra is reserved for at most one deliberate, scoped review per milestone of security-critical code (auth, sessions, age gate, deletion), never for bulk work, long contexts, or loops. Prefer luna/sol and sonnet for everything else. Keep prompts tight and file reads bounded when using any OpenAI model.
