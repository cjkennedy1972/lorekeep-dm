# ADR-015: Minimum age 18+ with age attestation at registration

Status: Proposed (human decision 2026-10-06, round 2: 18+ at launch; replaces the earlier 13+/parental-consent design) · Date: 2026-10-06

**Context.** The product launches for adults only. Collecting less data is the simplest compliance posture: no minors are onboarded, so no guardian or consent machinery is built. A 13-17 audience with parental consent is a possible later roadmap item and is recorded only as an extension point.

**Decision.**
- **Age attestation at signup:** either a date of birth or a required "I am 18 or older" checkbox (choice is an implementation detail; the checkbox is the minimal-data default). Under 18: signup refused, nothing stored beyond a short-lived cookie that blocks immediate retry with a different answer.
- **Minimal data:** if DOB is used, store only `age_attested_at` plus a boolean/`ageBand=adult` and discard the date; with the checkbox, store `age_attested_at` and `terms_version`. No age verification vendor in MVP. Attestation is self-declared and circumventable; it is a policy gate, not a security boundary.
- **Data model:** `accounts(id, email, password_hash, display_name, status: pending_email|active|suspended|deleting|deleted, age_attested_at, terms_version, ...)`. There is no age-band column, guardian table, or consent status in MVP schemas.
- **Third-party AI:** LLM endpoint config still carries a `retention/training` attestation (ADR-013).

**Later roadmap extension point (not MVP, no milestone work).** A 13-17 audience with parental consent would need: an `ageBand` on accounts, a guardian-consent entity and flow, a pending-consent account state, minors' content/feature restrictions, and legal review. Nothing in the MVP schema or APIs blocks adding these; none are designed or scheduled now.

**Alternatives.** Verified age (ID/card) for everyone (friction, PII, vendor). Keep 13+ with parental consent (rejected by decision: large legal/product surface).

**Consequences.** M0 loses the consent flow (about -1 week vs v0.2). Self-declared age can be bypassed; accepted for launch.

**Needs human?** Checkbox vs DOB entry (default: checkbox, minimal data). Legal wording of the attestation is deferred (architecture §17).
