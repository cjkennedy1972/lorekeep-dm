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

**Addendum (M3-08c, 2026-10-11): the "~0.5 s before the first token" line in Consequences is stale.** After the 64-character hold-back (ADR-023, M3-08b round 3), first visible text lags until more than 64 characters of the turn have been judged. Time to first visible text is therefore the time to generate and judge past that point, not the time to judge a single ~12-token chunk. The 2.5 s target is still unmeasured. This addendum supersedes that Consequences line only; the original text is left as written. Round 3 (ADR-023): once a sexual term appears in a turn, output is withheld until the turn ends or blocks, so first visible text for such turns has no bound.

**Addendum (M3-08c scanner remediation review, 2026-10-12):** a verdict-level scan and a visibility guarantee are distinct. The deterministic turn scanner latches `sensitive` when it detects a sexual term; the output gate then withholds the pending tail and all subsequent text until the attempt's final verdict. If a later minor reference blocks the turn, withheld sexual text is discarded. This can make first-visible-text latency unbounded for turns containing a sexual term. The output-level regression covers sexual-first text, more than 64 characters of filler, then a minor reference. Performance acceptance remains open: a fresh isolated 30,000 one-character-push run measured 384 ms, above ADR-023's ~100 ms target.

**Performance follow-up (2026-10-12):** the one-character append path and incremental carry bookkeeping reduce the adversarial 30,000-character scan to a 95 ms local median; the 10- and 400-character medians are 25 ms and 2.4 ms. The 75×400-chunk suite enforces the ~100 ms budget. This closes the performance acceptance item described above; local measurements are not CI timings.

**Performance contract clarification (2026-10-12):** the one-character path is a synthetic scheduler-sensitive stress workload: its isolated median is around 95 ms but may edge over 100 ms under concurrent test load. Automated acceptance is <100 ms for 10- and 400-character pushes and production-shaped 75×400-chunk workloads; the one-character stress assertion allows up to 120 ms. The scanner still reports all three medians for diagnosis.
