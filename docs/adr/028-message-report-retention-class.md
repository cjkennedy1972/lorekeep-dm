# ADR-028: Message reports are a distinct moderation-evidence retention class (addendum to ADR-017)

Status: Proposed: clarifies existing behavior, owner confirmation requested · Date: 2026-10-18 · Owner: Atlas · Amends ADR-017 for `message_reports` only; ADR-017 text is unchanged.

## Context

ADR-017's table puts operational and safety logs in a 30-day class, and its log-hygiene bullet says raw text "sits in the 30-day class only". Message report snapshots (M3-14) hold the reported message text and are kept 90 days while open, 30 days after review or dismissal, and 90 days after reopen (ADR-017, "Message reports" bullet). The two statements conflict for report snapshot text. The code follows the report clocks: migration `0021_message_reports.sql` defaults `expires_at` to 90 days, `apps/server/src/routes/operator.ts` sets the review clock, and `apps/server/src/retention/jobs/reports.ts` purges by `expires_at`. The message-report tests assert the same 90-day and 30-day values.

## Decision

- `message_reports.expires_at` keeps the current behavior: 90 days from creation while open, 30 days after review or dismissal, 90 days after reopen.
- Message reports are a documented moderation-evidence class, distinct from the 30-day operational-log class. Their snapshot text is exempt from the "raw text in the 30-day class only" rule in ADR-017.
- Nothing is deleted earlier than current behavior.
- Legal holds still override. The `legal_hold` flag on `message_reports` (migration `0031`) suspends deletion for that report, as ADR-017 requires.

## Rationale

Reports need review time: a report may sit in the queue for weeks, and a reviewer needs the snapshot after the report is reviewed to handle appeals or repeat abuse. Dropping report text at 30 days would also erase evidence that was retained at the time a decision was made. The 90-day open clock is already in the code, the migration, and the tests, so changing it would be a larger change than documenting it.

## Consequences

- ADR-017's "raw text sits in the 30-day class only" is superseded for report snapshots. ADR-017 text itself stays as written.
- Switching report retention to 30 days later is a one-line migration default change in `0021_message_reports.sql`, plus a sweeper expectation change in `reports.ts` and the report tests. Existing rows would need an explicit backfill decision.
- Account deletion still replaces authored text with `[removed]` in every report, regardless of the retention class (ADR-017).

## Needs human

Chris confirms this decision or overrides it. This ADR changes no behavior: the code already keeps 90/30/90. An override to 30 days is the one-line migration default change described under Consequences, with the backfill decision for existing rows. Legal-hold policy remains a human decision, as in ADR-017.
