# ADR-007: Layered moderation with sentence-chunk hold-back on output

Status: Proposed (default). Amended 2026-10-06 by ADR-016 (content tiers, mature default-on unless a player opts out), ADR-017 (30-day retention) · Date: 2026-10-06

**Context.** R-S1..S7, §9.4. Open-ended text, up to 6 humans, AI Dungeon 2021 precedent (research §6).

**Decision.**
- Input: cheap classifier + deterministic hard-floor rules at submit time; rejection is private to the sender and logged 30 days.
- Prompt: player text is quoted data in a delimited block; safety settings and the server-computed `contentTier` (`family|standard|mature`, ADR-016) are in the session block (stable text; cacheable when the endpoint supports caching). The mature clause is present only while the server-computed table predicate holds (no seated player opted out, endpoint verified and allows mature; ADR-016), re-evaluated at each round open and before each narration; text and the LLM cannot flip it. Explicit sexual content is out of scope. State changes are impossible via text (ADR-004).
- Output: stream is broadcast only after each sentence chunk passes a classifier (first chunk at ~12 tokens), which also enforces table settings and an SRD-denylist scan. Fail → discard unsent buffer, regenerate ≤ 2, then safe redirect template.
- X-card/pause: `SafetyFlag` event, steer-away instruction in next prompt, optional abort of in-flight generation.
- Tier awareness: input and output classifiers receive the table tier and use a tier-specific rubric; the **hard floor is identical at every tier** (sexual content involving minors, real-person defamation/harm, real-world harm instructions). Per-player lines/veils and pause apply at every tier (ADR-016). An endpoint that refuses mature prompts degrades to `standard` (probe flag `endpoint_allows_mature`).
- Logs (rejections, decisions, flags) are kept 30 days then deleted by the sweeper (ADR-017).
- No default human reading of private sessions; operator access only to flagged items, audited.

**Alternatives.** Post-hoc moderation with retraction (users see harmful text); full-turn buffering (adds seconds, breaks streaming).

**Consequences.** Adds up to ~0.5 s before the first token; unverified against the 2.5 s target (M3 gate). Classifier choice (provider endpoint vs cheap LLM) decided in M3.

**Needs human?** Age floor (18+, ADR-015) and 30-day retention are decided; training-use attestation per endpoint (ADR-013) and provider acceptable-use confirmation for mature (ADR-016) remain open.
