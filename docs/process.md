# Delivery process: Workboard tracking and definition of done

Applies to every milestone (M0-M5) of Lorekeep-DM. Board: `lorekeep-dm` on the OpenClaw Workboard.

## On dispatch of a milestone card
1. Atlas has the owning specialists (sage for design detail, compass for tickets) break the milestone's scope in `docs/architecture.md` section 8 and `docs/spec.md` into sub-task cards on the same board.
2. Each sub-task card has: one owner agent (forge or prism, or proof/sentinel/bastion/quill for their lanes), a label for the milestone, acceptance criteria copied from the spec story IDs, and the exact code paths or tests expected to exist when done.
3. Sub-task cards are linked to the milestone card as children. The milestone card cannot reach `done` until every child is `done`.

## Definition of done: nothing is done until it exists in the code
A card moves to `done` only after Atlas has verified, in the repo checkout at the commit being claimed:
- The files, functions, and routes named in the card exist (checked by reading or searching the code, not by trusting a report).
- The tests named in the card exist and pass (command and output recorded as proof on the card).
- The change is committed and pushed to `cjkennedy1972/lorekeep-dm` (commit SHA recorded on the card).
- Exit criteria are demonstrated, not asserted: a run, test output, or artifact reference is attached.

Rules:
- A worker's own "complete" or `passed` report is not verification. Workboard proof statuses are worker-reported; Atlas or proof re-runs the check independently.
- Lifecycle sync moves finished sessions to `review`. Only a verified card moves from `review` to `done`.
- A card with missing proof, or a milestone claimed from design docs alone, stays in `review` or `blocked`, and the gap is written on the card.
- Docs, specs, and ADRs count as done only for documentation cards, never for implementation cards.
- Milestone status reported to the human is derived from the board plus code verification, never from memory.

## Mandatory full gate before reporting a ticket done
Every agent works in its own clone (never the reference checkout), rebases on origin/main, then on a fresh `pnpm install --frozen-lockfile` runs: `pnpm -r typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r test`, `pnpm -r build`, and all Playwright e2e (`pnpm --filter @game/web exec playwright install chromium` once, then `pnpm --filter @game/web exec playwright test`) (plus the ticket's own verify commands, with Postgres via docker compose and an exported `DATABASE_URL` when DB-backed). All must exit 0 or the failure must be reported as a blocker, never described as "unrelated". Atlas re-runs the gate on a fresh clone of origin/main after every wave; a red main blocks starting dependent tickets.
