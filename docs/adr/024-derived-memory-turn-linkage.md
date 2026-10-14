# ADR-024: Turn linkage on derived memory so rewind can remove it

Status: Proposed (draft, owner-approved direction; not yet accepted) · Date: 2026-10-14 · Refines ADR-003 and ADR-006 · Remediates PR #185 finding 3 (M3-15 rewind)

**Context.** Rewind (ADR-003) reverts a DM turn by appending a `TurnReverted` event and hiding rows whose `turn_id` belongs to a reverted turn (`REVERTED_TURN_EXCLUSION` in `apps/server/src/persistence/rewind.ts`). Two derived-memory tables have no turn provenance, so that exclusion cannot reach them:

- `scene_summaries` (`apps/server/migrations/0014_registry.sql`, unique index added in `0015_scene_summary_idempotency.sql`). Written by `apps/server/src/dm/memory.ts` at scene close, keyed by `(session_id, scene_id)`. A reverted turn that closed a scene leaves its summary behind, and the idempotent insert then blocks regeneration.
- `registry_entries` (`0014_registry.sql`). Written by `upsertManyInTransaction` in `memory.ts` from validated registry tool events and from scene-close diffs. Versions chain through `supersedes_id` and `superseded_by`. A reverted turn can leave a v2 that superseded a v1 which is now stale. `registry_facts` cascade from entries but carry no turn id of their own.

Constraints: rewind must stay atomic with the `TurnReverted` append; derived rows must be removable without rewriting the append-only event log; existing rows have no recorded source turn; `scene_summaries` and `registry_entries` already enforce uniqueness that a delete-and-regenerate path depends on.

**Decision.**

1. Add a nullable `source_turn_id uuid` column to both `scene_summaries` and `registry_entries`. The type matches `events.turn_id` (the `::text` cast in `REVERTED_TURN_EXCLUSION` implies uuid; confirm against the events DDL before merging).
2. Set `source_turn_id` at write time to the DM turn that produced the row. For `scene_summaries`, that is the turn whose `NarrationCompleted` closed the scene. For `registry_entries`, it is the turn of the registry event (tool or scene-close) that produced the version. Writes that have no turn (for example, a manual or seed write) store NULL.
3. Add a partial index on `(session_id, source_turn_id) WHERE source_turn_id IS NOT NULL` on each table. Rewind filters on this column.
4. Rewind removes derived rows in the same transaction as the `TurnReverted` append:
   - `DELETE FROM scene_summaries WHERE session_id = $1 AND source_turn_id = ANY($2)`
   - For `registry_entries`, delete reverted versions, then clear `superseded_by` on any surviving row that pointed at a deleted row, so the prior version becomes current again. Deletes cascade to `registry_facts`.
5. Rows with NULL `source_turn_id` are never removed by rewind. They keep today's behavior, and the limitation is recorded in the rewind docs.

**Consequences.**

- Rewinding a turn removes its scene summary, so the next scene close regenerates it. The idempotent insert then succeeds because the conflicting row is gone.
- Superseded registry versions regain currency deterministically. The clear-`superseded_by` step must run inside the same transaction, or a concurrent read can see two current versions.
- Pre-migration rows stay with NULL provenance. A rewind of a turn that wrote them will leave them in place. This is the same gap as today, now explicit and bounded. Operators cannot rely on rewind to purge legacy derived memory.
- Writers gain one column. The `persistRegistryEvents` and scene-close paths must pass the turn id through; the event shape they receive must already carry it. Verify that before implementation.
- The `TurnReverted` payload and the events table are unchanged, so existing event replay keeps working.

**Rejected alternatives.**

- **Separate join table** (`derived_source(table_name, row_id, turn_id)`). Keeps the base tables untouched, but adds a polymorphic join, a second write per row, and a lookup on every rewind. The column is cheaper and keeps the delete in one statement.
- **Derive provenance from the event log at rewind time** (scan `events` for rows that point at scene summaries or registry ids). The events carry no reliable foreign key to the derived row ids, so this would depend on payload parsing and would miss rows written by tools.
- **Soft-delete with a `reverted_at` flag.** Preserves rows for audit, but every reader would need a new filter, and it conflicts with the unique index on `(session_id, scene_id)`, which would block regeneration.
- **NOT NULL column with a backfill.** Historical provenance cannot be recovered reliably, so a backfill would invent turn ids. Rejected in favor of nullable.
- **Turn-level rewind forbidden for turns that wrote derived memory.** Blocks a user-facing action to avoid a data problem. Rejected.

**Migration and backfill plan.**

1. New migration `apps/server/migrations/00NN_derived_turn_linkage.sql` (next free number at merge time; 0029 is the latest on origin/main as of this ADR). Contents: `ALTER TABLE ... ADD COLUMN source_turn_id uuid;` for both tables, then the two partial indexes. No `NOT NULL`, no default, no table rewrite.
2. No backfill. Existing rows stay NULL. Document this in the migration header comment and in the rewind docs.
3. Deploy order: migration, then writers that populate the column, then rewind that deletes by it. Rewind code must tolerate NULL.
4. Verification: extend `apps/server/test/db/rewind.test.ts` and `apps/server/test/db/summaries.test.ts`. Cases: (a) rewinding the closing turn removes the summary and a re-close regenerates it; (b) rewinding a turn whose registry v2 superseded v1 restores v1 as current; (c) NULL-provenance rows survive a rewind; (d) rewind and `TurnReverted` append roll back together when the delete fails.
5. Rollback: the column is nullable and unread by older code, so reverting the code is safe. Dropping the column is optional.

**Open items for implementation.** Confirm `events.turn_id` type. Confirm the registry tool event carries a turn id before the write path. Decide whether scene-close registry diffs use the closing turn or the turn that produced each diff.
