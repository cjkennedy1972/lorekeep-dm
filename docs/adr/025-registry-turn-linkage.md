# ADR-025: Registry turn linkage

Status: Accepted (supersedes the column-type decision in ADR-024; ADR-024 is unchanged)

## Context

ADR-024 proposed a uuid `source_turn_id` for derived memory. Main already has
`scene_summaries.turn_id text` (migration 0030), and `events.turn_id` is uuid. Registry
writes carry no turn id, so rewinding a turn could not remove the registry versions it
created.

## Decision

- Add nullable `registry_entries.turn_id text` with a partial index on
  `(session_id, turn_id) WHERE turn_id IS NOT NULL` (migration 0031). Text matches the
  0030 pattern.
- Pass the turn id as a separate `registryTurnId` argument to `writeTurn`; `RegistryEvent`
  shape is unchanged. Room uses `turnId?.turnId ?? actionId`.
- Scene-close registry diffs are stamped with the closing turn id.
- `Persistence.writeTurn` deletes registry versions tagged with reverted turn ids in the
  same transaction as the `TurnReverted` append. Superseded links are cleared before the
  delete because the `superseded_by` foreign keys have no `ON DELETE` action.
- Rows with NULL `turn_id` are never removed by rewind.

## Consequences

- Rewinding a turn restores the prior registry version and regenerates scene summaries
  whose closing turn was reverted.
- Registry writes that come from Room.persistRegistry have no turn id yet and stay NULL.
- If a surviving row supersedes a deleted row, the delete fails its foreign key and the
  transaction rolls back. This fails safe.
