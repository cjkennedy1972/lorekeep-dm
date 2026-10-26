# M4 exit gate 1: six-sim-player scripted sessions (evidence)

Gate 1 in `docs/plan/m4-exit-checklist.md` requires the six-client scripted sessions to be green on
the exact head that ships. This run covers the two open gaps:

- (i) host removes a seat during combat, on that seat's own turn;
- (ii) combat turn-timer expiry (dodge and hold) and a race between timer expiry and a late player command.

## Code under test

| Item | Value |
| --- | --- |
| Source base | `origin/main` @ `69374282877879e9782bbcb070951ef9dc2ee5b7` (fetched fresh) |
| Test head (exact SHA run below) | `4845b5f955bdff1613552e0865bf06404cc3329e` |
| Branch | `test/m4-9a-gate1-gaps` |
| New test file | `apps/server/test/db/sim-combat-gate1.test.ts` |
| Existing test files | unchanged (`sim-clients.test.ts`, `sim-combat.test.ts`) |
| Product code | unchanged (no product bugs found; nothing marked `it.fails`) |

## Environment

- Dedicated Postgres: Docker `postgres:16`, container `m4gate1-pg-30055`, host port `55461`. Removed after the run.
- Migrations: `pnpm migrate:up` in `apps/server` against the dedicated DB before the run.
- Node v26.12.1, pnpm workspace, Vitest 3.2.4.
- Built prerequisites: `pnpm --filter @game/schema build`, `pnpm --filter @game/rules-engine build`.

## Commands

```sh
# worktree and deps (fresh from origin/main)
git fetch origin
git worktree add -b test/m4-9a-gate1-gaps ~/.openclaw/workspace/wt-proof-gate1 origin/main
cd ~/.openclaw/workspace/wt-proof-gate1
pnpm install --frozen-lockfile

# dedicated DB
docker run -d --name m4gate1-pg-30055 -e POSTGRES_USER=lorekeep -e POSTGRES_PASSWORD=lorekeep \
  -e POSTGRES_DB=lorekeep -p 127.0.0.1:55461:5432 postgres:16
cd apps/server && DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55461/lorekeep pnpm migrate:up

# six-client suites on exact head
DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55461/lorekeep \
  pnpm exec vitest run test/db/sim-clients.test.ts test/db/sim-combat.test.ts \
  test/db/sim-combat-gate1.test.ts --reporter=verbose

# static checks and unit suites (repo root)
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test                                   # apps/server unit excludes test/db
cd tests/e2e && DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55461/lorekeep pnpm test

# teardown
docker rm -f m4gate1-pg-30055
```

## Per-scenario results (six-client suites, head `4845b5f`)

| File | Scenario | Result | Duration |
| --- | --- | --- | --- |
| sim-clients | sorts a batch by receiptSeq and includes every submitted action | pass | 307 ms |
| sim-clients | round resolution races: timer, all-in, and resolve-now give exactly one resolution | pass | 705 ms |
| sim-clients | round resolution races: a withdrawn action never reaches the batch | pass | 151 ms |
| sim-clients | queueing during resolving promotes the queued action | pass | 175 ms |
| sim-clients | reconnect re-syncs an in-flight submission | pass | 135 ms |
| sim-clients | host-only actions: only the host configures the timer or resolves now | pass | 355 ms |
| sim-clients | moderation: neutral private rejection, no leak | pass | 377 ms |
| sim-clients | OOC chat isolation: never reaches a DM prompt | pass | 176 ms |
| sim-clients | revoked seat cannot reconnect, submit, or read chat | pass | 189 ms |
| sim-clients | spotlight from the event log: every active player prompted over 6 players, 10 turns | pass | 99999 ms |
| sim-combat | reaction timeout declines at 15 s with cause timeout | pass | 15389 ms |
| sim-combat | reconnect mid-prompt replays the open prompt | pass | 2475 ms |
| sim-combat | reconnect mid-prompt: monster-bound controller answers after reconnect | pass | 289 ms |
| sim-combat | chat isolation from combat narration | pass | 304 ms |
| sim-combat | host kick during open reaction prompt declines, closes 1008 | pass | 507 ms |
| sim-combat | spotlight over combat turns, every PC gets a turn each complete round | pass | 11258 ms |
| sim-combat-gate1 | host removes a seat on its live turn, configured **dodge** (gap i) | pass | 579 ms |
| sim-combat-gate1 | host removes a seat on its live turn, configured **hold** (gap i) | pass | 418 ms |
| sim-combat-gate1 | turn timer expiry with **dodge**, late command rejected (gap ii) | pass | 30336 ms |
| sim-combat-gate1 | turn timer expiry with **hold** (gap ii) | pass | 30409 ms |
| sim-combat-gate1 | race: end-turn on the deadline edge gives exactly one resolution (gap ii) | pass | 30327 ms |

What each gate-1 scenario asserts (all waits are predicate or event waits, no fixed sleeps):

- **Host revoke on the live turn (dodge, hold).** Timer is off so only the removal can resolve the turn. The
  host sends `KickSeat`. Asserts: `SeatRevoked` with `cause: host-kick`; the removed socket closes with 1008;
  exactly one `TurnTimedOut` for the victim's entity with the configured action; exactly one `TurnResolved`
  for that turn; the active entity moves off the removed seat; a reconnect by the removed seat returns 1008;
  the other five clients' last `CombatTracker` names the server's live active entity.
- **Dodge expiry.** Timer 30 s, `timeoutAction: dodge`. Waits on the server's own `TurnOpened.deadline`.
  Asserts one `TurnTimedOut` (action `dodge`), one `DodgeDeclared` with `source: timeout`, one `TurnResolved`,
  and that the owner's later `end-turn` is rejected with `not-your-turn`.
- **Hold expiry.** Same as dodge with `timeoutAction: hold`. Asserts action `hold`, zero `DodgeDeclared` for the
  entity, one `TurnResolved`.
- **Race.** Timer 30 s, dodge. Waits until `Date.now()` is within 20 ms of the server deadline, then sends the
  owner's `end-turn`. Asserts exactly one `TurnResolved` for the turn. If the timer won, the player's command
  must reply `Error`; if the player won, it must reply `CombatTracker` and there is no `TurnTimedOut`.

## Totals

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| Six-client (sim-clients + sim-combat + sim-combat-gate1), head `4845b5f` | 3 | 21 (10 + 6 + 5) | 21 passed, 0 failed |
| Unit: `packages/schema` | 9 | 164 | passed |
| Unit: `packages/evals` | 7 | 94 | passed |
| Unit: `packages/engine` | 47 | 493 | passed |
| Unit: `apps/web` | 41 | 329 | passed |
| Unit: `apps/server` (excludes `test/db`) | 110 | 2499 | passed |
| E2E: `tests/e2e` (real server, `DATABASE_URL` set) | 13 | 187 | passed |
| `format:check`, `lint`, `typecheck` | — | — | clean |

Note on `tests/e2e`: the first `pnpm test` at the repo root ran without `DATABASE_URL`, and
`tests/e2e/support.ts` throws in that case (7 spec files failed at load). The package was rerun
with `DATABASE_URL` set and passed 187/187. The failure was the environment, not the code.

## Run output excerpt (head `4845b5f955bdff1613552e0865bf06404cc3329e`)

```
 ✓ test/db/sim-combat-gate1.test.ts > host removes a seat on that seat’s turn (host revoke mid-combat) > the live turn resolves with the configured dodge, the seat loses access, and the other clients agree 579ms
 ✓ test/db/sim-combat-gate1.test.ts > host removes a seat on that seat’s turn (host revoke mid-combat) > the live turn resolves with the configured hold, the seat loses access, and the other clients agree 418ms
 ✓ test/db/sim-combat-gate1.test.ts > combat turn timer expiry and resolve races > dodge: expiry resolves the turn once; a late command from the timed-out seat is rejected 30336ms
 ✓ test/db/sim-combat-gate1.test.ts > combat turn timer expiry and resolve races > hold: expiry resolves the turn once with hold and no dodge 30409ms
 ✓ test/db/sim-combat-gate1.test.ts > combat turn timer expiry and resolve races > race: a player end-turn landing on the deadline edge gives exactly one resolution 30327ms
 ✓ test/db/sim-combat.test.ts > host kick during an open reaction prompt > declines immediately with cause presence, closes the kicked socket 1008, and does not stall 507ms
 ...
 Test Files  3 passed (3)
      Tests  21 passed (21)
```

Full verbose output: `/tmp/m4g1-sixsim-final.log` in the worktree session (not committed).

## Bugs

No product bugs were found. Nothing was marked `it.fails`, and no product code was changed.

## Scope notes

- "Revoke" is `KickSeat` (`cause: host-kick`). The product has no separate revoke action, so these
  scenarios exercise that path.
- Timer scenarios take about 30 s each. The WS minimum for `ConfigureTurnTimer` is 30 s, and the
  server clock is real, so fake timers cannot drive them. Fake-timer unit coverage remains in
  `apps/server/test/room/turnTimer.test.ts`.
- The old evidence file `m4-9a-six-client-combat-sim.md` still references the superseded worktree and
  container; this file replaces it for gate 1.
