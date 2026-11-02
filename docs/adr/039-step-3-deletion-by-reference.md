# ADR-039 addendum: step 3 — deletion by reference

Status: Proposed · Date: 2026-11-01 · Depends on: ADR-039 and migration 0045 · Scope: deletion only

## Decision

Use `derived_memory_character_refs` as the authoritative index from `(session_id, character_id)` to derived rows. A scene summary is referenced by `(row_kind='scene_summary', row_id=scene_summaries.id)`; a registry version by `(row_kind='registry_entry', row_id=registry_entries.id)`. `session_character_tokens` remains the stable, opaque per-session character identity map used by the ADR-039 write/read gates. Neither summaries nor registry entries/facts may persist a player-character display name, alias, quoted player text, or identity-bearing free text: generated prose contains validated tokens, and each row's index records every character token it contains. Registry facts belong to their parent entry and are deleted by its existing `ON DELETE CASCADE`; they do not get independent reference-index rows. NPC and other non-player entity names remain ordinary canonical registry data.

### Schema and rollout

Migration `apps/server/migrations/0045_derived_memory_character_refs.sql` is the schema baseline: its two reference tables, uniqueness/check constraints, lookup indexes, and reconciliation checkpoint are additive. Step 3 does not rewrite legacy rows or add another schema migration unless implementation uncovers a concrete missing constraint. Keep the tables and token mappings through rollback; do not drop them as part of code rollback. Writers must insert/update derived row content and replace its reference-index set in the same transaction. A missing mapping or incomplete reference coverage is not permission to guess from names or text; indexed deletion stays disabled until reconciliation is complete, and a deletion that cannot establish complete coverage must fail closed/defer without claiming completion.

Deploy compatibly: schema first; deploy reference-aware readers/writers and deletion while legacy rows remain untouched; establish/reconcile index coverage under bounded, resumable batches; enable indexed deletion only after coverage is verified. Reconciliation may index a row only from trusted captured character bindings/reference metadata, never substring matching or inferred names. Each checkpointed batch is atomic and restart-safe. No step-3 operation clears legacy data.

### Deletion semantics

For each affected session, perform the existing lease/fence and legal-hold checks before mutation and again under the deletion transaction. A held session is wholly unchanged, including summaries, registry entries/facts, token mappings, and reference-index rows; report deletion incomplete. In an unheld session, select row IDs solely through `(session_id, character_id)` in the reference index, delete referenced summaries and registry versions (facts cascade), then delete that character's index rows and token mapping in the same transaction. Delete/reconciliation races serialize or abort and retry; never leave a success result with partial cleanup. Preserve other characters' rows and mappings. Session deletion still relies on session-level cascade. Account deletion applies this operation to each deleted character; a shared row referencing multiple characters is removed when any referenced character is deleted, because its prose cannot safely be retained for the others. This is whole-row deletion, not text redaction.

Do not touch canonical events or snapshots under this addendum; their existing redaction/retention rules continue. Rewind remains governed by ADR-024/025: remove turn-linked derived rows atomically with rewind, repair surviving supersession links, and retain character/session token mappings. Deletion is idempotent. A retry after an aborted transaction is safe; a completed deletion may leave no matching rows and is still success once coverage and hold checks are established.

## Ordered implementation tasks for Forge (failing-first)

Each task starts by adding the named failing tests against current behavior; then implement the smallest change that makes them pass. Keep these as separate, reviewable changes in order.

1. **Reference-index transaction contract.** Add failing DB tests showing summary/registry writes atomically replace their exact character-reference rows, rollback leaves neither half, facts have no independent index, and incomplete reconciliation blocks indexed deletion. Implement transactional index maintenance using migration 0045 and its checkpoint; add bounded restart/resume coverage tests. Legacy rows must remain byte-for-byte untouched.
2. **Single-character deletion.** Add failing tests proving deletion selects only rows indexed for the target `(session, character)`, removes referenced summaries and registry versions with facts cascading, removes only that character's index/mapping, and preserves unrelated rows/mappings. Include a test that makes name/text scans return misleading matches and proves those rows are unaffected. Implement the reference-index deletion transaction.
3. **Safety and concurrency.** Add failing tests for held sessions remaining wholly unchanged; active/stale lease, deletion fence, partial coverage, and concurrent write/reconciliation races failing closed or retrying atomically; repeated deletion being idempotent; shared rows referencing two characters being removed on either deletion. Implement hold/fence/coverage locking and safe retry/result semantics.
4. **Integration contracts.** Add failing account-deletion tests over owned, occupied, bound, and reusable-character cases; rewind tests proving turn-linked rows and supersession repair remain atomic without deleting mappings; export tests proving authorized screened content only and no mapping exposure. Wire the shared deletion module into callers without duplicating row selection logic.

**Step 4 is deliberately not part of this design or implementation.** The separate legacy-clear operation remains last, after steps 1–3 are implemented and merged; it requires its own dry run and counts-only audit. Nothing in this addendum authorizes, triggers, or performs it.

## Open implementation questions

- Reconciliation completion must be an enforced prerequisite at the same transaction/fence that performs deletion, not just an operational assertion; implementation should identify the authoritative coverage proof and lock order.
- Clarify whether a held session causes the entire account-deletion attempt to remain pending (recommended) or allows other unheld sessions to complete while reporting partial status; preserve the existing job contract unless the implementation evidence requires a change.
- Confirm handling of character identity rows whose authoritative character record has already been removed: retain enough opaque ID/index state to honor holds and complete later deletion without re-identification by text.

This addendum is design-only. No production data, legacy derived rows, or step-4 clear job is touched.
