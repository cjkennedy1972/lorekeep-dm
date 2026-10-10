# ADR-017: 30-day log retention with scheduled deletion jobs

Status: Proposed (human decision 2026-10-06: 30-day log retention) · Date: 2026-10-06

**Context.** Moderation and operational logs are kept 30 days for abuse review. Gameplay data (events, snapshots) is a different class: needed to play and resume. Accounts need export and deletion (ADR-014); age attestation is in ADR-015.

**Decision.** Data classes and clocks:

| Class | Examples | Retention |
|---|---|---|
| Operational/safety logs | rejected inputs, moderation decisions, `SafetyFlag` details, LLM request/response logs, auth and access logs | **30 days** from write, then hard-deleted |
| Reverted turns | hidden transcript from rewind | 30 days |
| Gameplay data | events, snapshots, registry | live while session active; `archived` after 14 days idle; deleted 90 days after archive unless claimed (spec A4) |
| Uploaded assets (later phase) | maps, 3D | not in MVP; policy deferred (architecture §17) |
| Exports | account export archives | 7 days |
| Backups | Postgres backups | rolling 30 days, so full erasure lags deletion by at most 30 days |

- **Jobs** (one `retention-sweeper` worker, idempotent, nightly, logged with counts only): purge expired log rows by `expires_at` column set at write time; purge reverted turns; archive idle sessions; delete archived sessions; purge expired exports; run **account deletion pipeline** (immediate deactivation, PII hard-deleted within 30 days, solo sessions deleted, shared-session redaction).
- **Account deletion rule (owner-based):** a session the deleted account owns passes to a seated co-player whose account is `active`; if none exists the session is purged, solo or not. Sessions where the deleted account is only a seat are redacted, not purged. "Last remaining seat" is deliberately not a criterion: a co-seat that is suspended or deleting does not keep a session alive.
- **Log hygiene by design:** logs store IDs and decision labels, not raw text where avoidable; raw text sits in the 30-day class only. LLM provider retention is the operator's responsibility and is attested in endpoint config (ADR-013).
- **Legal hold:** an operator-set hold flag on a flagged item suspends deletion for that item only, with an audit entry. Policy for holds is a human decision.
- **Verification:** each job has a test that seeds expired rows and asserts deletion; a monitor alerts if a sweep has not completed in 26 hours.

**Alternatives.** Keep logs indefinitely (privacy risk). Delete on read (no abuse-review window).

**Consequences.** Abuse investigations older than 30 days are impossible without a hold. Redaction is the only mutation of an otherwise append-only log.

**Known limits (account deletion).**
- A session with a live Room on another node defers deletion until the room is idle or its lease expires; the sweeper never evicts it.
- The sweeper defers on any live lease for the session, with no preemption.
- The deletion transaction sets no `lock_timeout`; a blocked lock waits rather than failing fast.
- Archive file removal runs inside the transaction. It is idempotent, so a rollback at worst leaves an export row whose archive is already gone.
- A pending room whose `start()` has not completed fails closed: deletion defers.
- Exact-string scrubbing removes typed text and character names from derived rows. LLM paraphrases of them in scene summaries and registry facts are not scrubbed.

**Needs human?** Legal-hold policy (deferred, architecture §17).
