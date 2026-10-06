# ADR-015: Minimum age 18+ with birthdate attestation at registration

Status: Proposed (round 2: 18+ at launch; round 3: birthdate entry) · Date: 2026-10-06

**Context.** The product launches for adults only. Collecting less data is the simplest compliance posture: no minors are onboarded, so no guardian or consent machinery is built. A 13-17 audience with parental consent is a possible later roadmap item and is recorded only as an extension point.

**Decision.**
- **Signup flow:** the registration form asks for a birthdate. The server computes age (never the client) and gates on 18+. Under 18: signup refused, **nothing stored** about that attempt except a short-lived cookie that blocks an immediate retry with a changed answer. Over 18: the account is created.
- **Minimal data (recommended, flagged for the human):** store only `is_adult=true` and `age_checked_at`, plus `terms_version`. The birthdate is validated in memory and discarded. Storing the DOB itself needs a justification (for example a later 13-17 audience, or recurring age re-checks); none exists now.
- **Data model:** `accounts(id, email, password_hash, display_name, status: pending_email|active|suspended|deleting|deleted, is_adult, age_checked_at, terms_version, ...)`. No DOB, age-band, guardian, or consent columns in MVP. If the human chooses to keep the DOB, add `birthdate` (encrypted at rest, included in export and deletion, covered by ADR-017) and revisit privacy text.
- **No age verification vendor in MVP.** Attestation is self-declared and circumventable; it is a policy gate, not a security boundary.
- **Third-party AI:** LLM endpoint config still carries a `retention/training` attestation (ADR-013).

**Later roadmap extension point (not MVP, no milestone work).** A 13-17 audience with parental consent would need: an `ageBand` on accounts, a guardian-consent entity and flow, a pending-consent account state, minors' restrictions, and legal review. If that happens, storing the DOB becomes a real option. Nothing in the MVP schema blocks it.

**Alternatives.** "I am 18" checkbox (round 2 default, replaced by birthdate entry). Verified age (ID/card) for everyone (friction, PII, vendor). Keep 13+ with parental consent (rejected: large legal/product surface).

**Consequences.** M0 has no consent flow. Self-declared age can be bypassed; accepted for launch. Storing only the adult flag keeps the DOB out of exports, backups, and deletion scope.

**Needs human?** Yes: confirm "store adult flag + check date only, discard DOB" (recommended) versus keeping the DOB. Legal wording of the attestation is deferred (architecture §17).
