# ADR-003: Append-only event log + per-turn snapshots; rewind restores state with a new seed

Status: Proposed (default) · Date: 2026-10-06

**Context.** Autosave after every turn (US-R2), resume ≤ 3 s, host rewind of last turn (R-S7), replayable dice for tests.

**Decision.** `events` table is append-only. A full-state snapshot is written in the same transaction as the last event of each resolved turn. Rewind appends `TurnReverted`, restores the prior snapshot as head, and keeps the reverted transcript hidden but retained for the abuse-review window. The retry turn draws a **new** dice seed; one rewind per turn.

**Alternatives.** Mutable state row only (no replay/rewind); full event-sourcing with no snapshots (slow resume).

**Consequences.** Cheap resume, deterministic tests. Rewind cannot be used to replay identical dice (there is a policy choice here: reuse the seed would make rewinds an information leak about outcomes).

**Needs human?** Yes, light: confirm the rewind dice policy (spec Q8 is adjacent).
