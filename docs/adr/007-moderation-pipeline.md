# ADR-007: Layered moderation with sentence-chunk hold-back on output

Status: Proposed (default) · Date: 2026-10-06

**Context.** R-S1..S7, §9.4. Open-ended text, up to 6 humans, AI Dungeon 2021 precedent (research §6).

**Decision.**
- Input: cheap classifier + deterministic hard-floor rules at submit time; rejection is private to the sender and logged 30 days.
- Prompt: player text is quoted data in a delimited block; safety settings are in the cached session block. State changes are impossible via text (ADR-004).
- Output: stream is broadcast only after each sentence chunk passes a classifier (first chunk at ~12 tokens), which also enforces table settings and an SRD-denylist scan. Fail → discard unsent buffer, regenerate ≤ 2, then safe redirect template.
- X-card/pause: `SafetyFlag` event, steer-away instruction in next prompt, optional abort of in-flight generation.
- No default human reading of private sessions; operator access only to flagged items, audited.

**Alternatives.** Post-hoc moderation with retraction (users see harmful text); full-turn buffering (adds seconds, breaks streaming).

**Consequences.** Adds up to ~0.5 s before the first token; unverified against the 2.5 s target (M3 gate). Classifier choice (provider endpoint vs cheap LLM) decided in M3.

**Needs human?** Yes: age floor, retention, training-use policy (Q4).
