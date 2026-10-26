# M4-8 evidence: keyboard-only party combat (real server)

Test code commit: `52fd815` (branch `test/m4-8-party-kbd-combat-e2e`, from origin/main `74e8a4f`).
Files: `apps/web/e2e-party/party-kbd-combat.spec.ts`, `apps/web/e2e-party/combat-helpers.ts`.
No application source was changed in `apps/web/src` or `apps/server`.

## Environment

- Postgres: dedicated container `m48-pg` on 127.0.0.1:55433 (the Homebrew Postgres on 5432 shadows the docker port and has no `lorekeep` role).
- `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55433/lorekeep`
- Real server: `apps/server/test/live/serve.party.live.ts` (vitest, LIVE_PORT 8800) plus vite on LIVE_WEB_PORT 5176, started by `apps/web/playwright.party.config.ts` (`reuseExistingServer: false`, workers 1, chromium).

## Commands and results

| Command (cwd `apps/web` unless noted) | Result |
|---|---|
| `pnpm exec playwright test -c playwright.party.config.ts e2e-party/party-kbd-combat.spec.ts --reporter=list` (x3, each a fresh server boot, no retries) | 3 of 3 passed, 1 test each, about 4.0 s each |
| same command, whole `e2e-party/` directory | see "Known failure" below: 1 passed, 2 failed |
| `pnpm exec prettier --check apps/web/e2e-party/combat-helpers.ts apps/web/e2e-party/party-kbd-combat.spec.ts` (repo root) | pass |
| `pnpm exec eslint apps/web/e2e-party/combat-helpers.ts apps/web/e2e-party/party-kbd-combat.spec.ts` (repo root) | exit 0 |
| `pnpm --filter @game/web typecheck` | exit 0 |
| `pnpm --filter @game/web test` | 39 files, 306 tests passed |

Logs: `/tmp/m48-stable-{1,2,3}.log`, `/tmp/m48-party-all.log`, `/tmp/m48-kbd-run2.log`.

Not run: the root `pnpm lint`, root `pnpm format:check`, and root `pnpm typecheck` (only the web package was run). Run them before marking the PR ready.

## What the spec covers (one test, six steps, one connected session)

1. Keyboard reaches "Describe battlefield (Alt+D)" and "Sort by distance" with a drawn focus ring (outline style not none, width at least 2 px).
2. Move cancel: Enter starts move, ArrowRight previews, Escape cancels; token coordinates unchanged; "Movement cancelled." announced.
3. Move confirm: arrows until the preview announces "Path cost N feet."; Enter sends it; each of three browsers shows the active token at the target cell within 1000 ms; the active seat stays active.
4. List-driven: token table (`Tokens and terrain`) lists the active seat at the same grid coordinates the map token uses.
5. Alt+D opens the battlefield description section keyboard-only.
6. Axe (wcag2a/aa, wcag21a/aa) on the combat screen: no critical or serious violations.
7. Mobile 390x844: "Show map" reachable by Tab and opens the battle map.

### Latency method

Timing starts immediately before the keypress that confirms the move and stops when each of the three browsers has a `ul[aria-label="Combat tokens"] li[data-active="true"]` at the target `data-x`/`data-y`. Each browser waits with a 1000 ms timeout. Measured: 31 ms, 37 ms, 37 ms, 36 ms across four runs. This is end-to-end on localhost (including the server's move handling), not a production network measurement.

## Known failure (not fixed here)

When two specs run in the same server boot, the second spec's browsers never receive room state. Measured:

- `party-combat.spec.ts` alone: passes.
- `party-kbd-combat.spec.ts` alone, as the restructured single test: passes on 4 separate boots (1 exploratory + 3 recorded).
- `party-kbd-combat.spec.ts` as the earlier multi-test version: the first test passes, later tests fail the same way (see below).
- `party-combat` then `party-kbd-combat` in one boot: kbd fails at "Initiative tracker" (30 s).
- `party-round.spec.ts` after `party-combat` in one boot: fails the same way.
- Two tests in `party-kbd-combat` split into separate tests: the second fails the same way. Restructuring into one test fixed it.

Each failing page stays at "Connecting to the room… / Waiting for room state…". The root cause is not confirmed. The likely direction is server-side handling of seats that reconnect after all their browsers closed in the same process, or accounts reused across specs. This is a real defect to investigate, not a test flake, and it was not masked with retries. Until fixed, each spec file needs its own server boot (`playwright test <file>`), and the full `e2e-party/` run is red.

## Gate status (honest)

- Keyboard-only move (preview, cancel, confirm), focus visibility, list-driven coordinates, Alt+D description, axe, mobile fallback: covered by the spec above.
- Reaction prompt keyboard answer in party mode: NOT covered. A human reaction prompt requires a PC as the reactor (a hostile moves out of reach during monster turns), which the current party fixture does not script.
- Area aim from `CombatOptions.areas` in the Game screen: NOT covered and NOT implemented. `Game.tsx` receives `areas` but does not render them. The party fixture's PCs may not have burning-hands.
- Non-drag pointer equivalents (canvas click plus Confirm/Cancel buttons): NOT covered in this PR.
- Map-sync latency: measured for the single move above only.

## Defects found

- None exposed by the new spec in `apps/web` (all six steps passed on first real run after restructuring; the earlier failures were the cross-spec reconnect issue above).
- Candidate, not changed: `Game.tsx` "Move to {x}, {y}" button labels use 0-based coordinates, while keyboard announcements and the token table use letter+1-based coordinates (B3 style). Not exposed by a failing test, so left alone.
- Candidate, not changed: Game screen `Show map` / `Hide map` is a JS fallback (`useNarrowViewport`), while `sandboxCombat.css` only handles the sandbox layout. The mobile step passes on the Game screen.

## Follow-up card text for Atlas

1. Investigate reconnect failure after a spec closes its browsers in the same server boot (see Known failure). Acceptance: `e2e-party/` runs green in one boot.
2. Reaction prompt keyboard-only e2e in party mode: add a fixture where a PC is the reactor (a monster moves out of reach), then assert `reaction` options via Accept/Decline and the `y`/`n` keys.
3. Area aim in Game.tsx: render `CombatOptions.areas` as a keyboard-selectable option list with affected-unit feedback, then add an e2e with a caster fixture.
4. Non-drag pointer equivalents: canvas click to the same destination as the keyboard cursor, with the Confirm and Cancel buttons; add a test.
5. Align "Move to" labels to the 1-based coordinates the keyboard and table use.

## Uncertainties

- The reconnect root cause is unconfirmed (see above).
- `e2e-party/*.ts` is not in the web `tsconfig` include list, so typecheck does not cover the new spec. ESLint and the run itself do.
- No PR merge, ready-for-review, card assignment, or Sentinel/Bastion review was requested or done.
