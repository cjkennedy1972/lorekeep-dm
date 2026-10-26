# M4-8 evidence: keyboard-only party combat (real server), PARTIAL for gate 4

Test code commit: `6f7d183` (branch `test/m4-8-party-kbd-combat-e2e`). It sits on top of `52fd815`, the first spec commit, and the branch head includes this evidence file.
Files: `apps/web/e2e-party/party-kbd-combat.spec.ts`, `apps/web/e2e-party/combat-helpers.ts`, `apps/web/e2e-party/party-combat.spec.ts` (uses the shared open/close helpers).
No application source was changed in `apps/web/src` or `apps/server`.

Scope: this PR covers part of gate 4 only. It does not show that combat is keyboard-only. Attack, reaction prompts, area aim, and pointer equivalents are not covered (tracked on card `91ebb735`; see "Gate status").

## Environment

- Postgres: a dedicated, throwaway container on 127.0.0.1 (postgres 16, its own port), migrated with `pnpm migrate:up` in `apps/server`. It is removed after the runs.
- `DATABASE_URL` is set to that container's URL (`$DATABASE_URL`, local-only, never committed).
- Real server: `apps/server/test/live/serve.party.live.ts` (vitest, LIVE_PORT 8800) plus vite on LIVE_WEB_PORT 5176, started by `apps/web/playwright.party.config.ts` (`reuseExistingServer: false`, workers 1, chromium, no retries).

## Commands and results

| Command (cwd `apps/web` unless noted) | Result |
|---|---|
| `pnpm exec playwright test -c playwright.party.config.ts e2e-party/` (whole directory, one server boot), run 1 and run 2 | 12 passed, 1 skipped (the pre-existing `test.fixme` for "Not seated"), about 14.3 s each, 0 retries |
| `pnpm exec playwright test -c playwright.party.config.ts e2e-party/party-kbd-combat.spec.ts` (alone) | 1 passed |
| Same whole-directory command before the helper fix (baseline) | 1 passed, 2 failed: `party-kbd-combat` and the first `party-round` test both waited at "Connecting to the room" |
| `pnpm exec prettier --check` on the three changed e2e files, and `pnpm format:check` at the repo root | pass |
| `pnpm exec eslint` on the three changed e2e files (repo root) | exit 0 |
| `pnpm --filter @game/web typecheck` | exit 0 (note: `e2e-party/*.ts` is not in the web tsconfig include, so typecheck does not cover these specs; eslint and the run do) |
| `pnpm --filter @game/web test` | 39 files, 306 tests passed |
| `pnpm lint` (repo root) | exit 0 |

## What the spec covers (one test, six steps, one connected session)

1. Keyboard reaches "Describe battlefield (Alt+D)" and "Sort by distance" with a drawn focus ring (outline style not none, width at least 2 px).
2. Move cancel: Enter starts move, ArrowRight previews, Escape cancels; token coordinates unchanged; "Movement cancelled." announced.
3. Move confirm: arrows until the preview announces "Path cost N feet."; Enter sends it; each of three browsers shows the active token at the target cell within 1000 ms; the active seat stays active.
4. List-driven: token table (`Tokens and terrain`) lists the active seat at the same grid coordinates the map token uses.
5. Alt+D opens the battlefield description section keyboard-only.
6. Axe (wcag2a/aa, wcag21a/aa) on the combat screen: no critical or serious violations.
7. Mobile 390x844: "Show map" reachable by Tab and opens the battle map.

### Latency method

Timing starts immediately before the keypress that confirms the move and stops when each of the three browsers has a `ul[aria-label="Combat tokens"] li[data-active="true"]` at the target `data-x`/`data-y`. Each browser waits with a 1000 ms timeout. Measured across the runs in this PR: 31-40 ms. This is end-to-end on localhost (including the server's move handling), not a production network measurement.

## Cross-spec reconnect failure: harness defect, fixed

Earlier, a second spec in the same server boot never received room state and stayed at "Connecting to the room… / Waiting for room state…".

Cause: the seat's resume token is stored in the browser's localStorage (`apps/web/src/room/client.ts`). The helpers opened each seat in a fresh context with only the `sid` cookie, so the browser looked like a new device. The server then requires host approval for the seat claim, which the scripted fixture never gives. `party-round.spec.ts` already avoided this by saving and restoring each account's `storageState`.

Fix (commit `6f7d183`): `openMember` in `combat-helpers.ts` restores each account's saved storageState, and the new `closeMember` saves it before closing. `party-combat.spec.ts` uses the same helpers. After this change, the whole `e2e-party/` directory passes in one server boot, and the kbd spec passes alone.

This is not a product reconnect defect. The new-device approval path is the intended behavior, and the earlier write-up in this file that called it a real defect was wrong. Logs are not committed; the runs above are reproducible with the commands in the table.

## Gate status (honest)

- Covered by this PR (partial gate 4): keyboard move preview, cancel, and confirm; focus visibility on the battlefield controls; list-driven coordinates; Alt+D description; axe serious/critical on the combat screen; the 390x844 "Show map" fallback; three-browser sync for one move (single move only).
- NOT covered, still open on card `91ebb735`:
  - Attack actions by keyboard.
  - Reaction prompt keyboard answer in party mode. It needs a PC reactor (a hostile moves out of reach during monster turns), which the current party fixture does not script.
  - Area aim from `CombatOptions.areas` in the Game screen. `Game.tsx` receives `areas` but does not render them, and the party fixture's PCs may not have burning-hands.
  - Non-drag pointer equivalents (canvas click plus Confirm/Cancel buttons).
- Map-sync latency: measured for the single move above only.

## Defects and candidates (not changed here)

- Candidate: `Game.tsx` "Move to {x}, {y}" button labels use 0-based coordinates, while keyboard announcements and the token table use letter+1-based coordinates (B3 style). Not exposed by a failing test, so left alone.
- Candidate: Game screen `Show map` / `Hide map` is a JS fallback (`useNarrowViewport`), while `sandboxCombat.css` only handles the sandbox layout. The mobile step passes on the Game screen.

## Follow-up for card `91ebb735`

1. Keyboard-only attack in party combat, with an e2e step.
2. Reaction prompt keyboard-only e2e in party mode: add a fixture where a PC is the reactor, then assert the `reaction` options via Accept/Decline and the `y`/`n` keys.
3. Area aim in Game.tsx: render `CombatOptions.areas` as a keyboard-selectable option list with affected-unit feedback, then add an e2e with a caster fixture.
4. Non-drag pointer equivalents: canvas click to the same destination as the keyboard cursor, with the Confirm and Cancel buttons; add a test.
5. Align "Move to" labels to the 1-based coordinates the keyboard and table use.

## Uncertainties

- The sync numbers come from localhost only.
- `e2e-party/*.ts` is not in the web `tsconfig` include list, so typecheck does not cover the specs.
- No PR merge, ready-for-review, or Sentinel/Bastion review was requested or done.
