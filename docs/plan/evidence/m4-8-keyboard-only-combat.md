# M4-8 evidence: keyboard-only party combat (real server), PARTIAL for gate 4

Branch `test/m4-8-kbd-reaction-area`, based on draft PR #339 (`test/m4-8-party-kbd-combat-e2e`, head `46f6caf`).
Code commits on this branch:

- `e865773` keyboard area-aim list over `CombatOptions.areas`; 1-based "Move to" labels.
- `f624d51` keyboard-only attack step in party combat e2e; goblin seeded in reach; roll frames asserted.

Run against: `f624d51` (plus this evidence file).

Scope: gate 4 is only partly covered. Attack by keyboard is now covered end to end. Reaction prompts with a PC reactor are blocked by a server join rule (see below). Area aim is implemented with unit tests but has no e2e. Pointer equivalents are not done.

## Environment

- Postgres: a dedicated Docker container `kbdgaps-pg` on 127.0.0.1:55462 (`POSTGRES_DB=lorekeep_kbdgaps`), migrated with `pnpm migrate:up` in `apps/server`. Removed with `docker rm -f kbdgaps-pg` after the run.
- `DATABASE_URL` pointed at that container for the run only. The URL is not committed.
- Real server: `apps/server/test/live/serve.party.live.ts` (vitest, LIVE_PORT 8800) plus vite on LIVE_WEB_PORT 5176, started by `apps/web/playwright.party.config.ts` (`reuseExistingServer: false`, 1 worker, chromium, 0 retries).

## Commands and results

Run from the repo root unless noted.

| Command | Result |
|---|---|
| `pnpm exec prettier --write apps/web/e2e-party/combat-helpers.ts apps/web/e2e-party/party-kbd-combat.spec.ts` | formatted |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | "All matched files use Prettier code style!" |
| `pnpm --filter @game/web exec tsc --noEmit` | exit 0 (note: `e2e-party/*.ts` is not in the web tsconfig include, so typecheck does not cover the specs; eslint and the run do) |
| `pnpm --filter @game/web test` | 40 files, 316 tests passed |
| `pnpm build` | exit 0 |
| `DATABASE_URL=postgres://postgres:kbdgaps@127.0.0.1:55462/lorekeep_kbdgaps pnpm --filter @game/web exec playwright test -c playwright.party.config.ts` (whole `e2e-party/` directory, one server boot) | **12 passed, 1 skipped** (the pre-existing `test.fixme` "an unseated player sees Not seated and can rejoin"), 15.0 s, 0 retries |

The one-boot run includes the attack step, the move steps, the round specs, and the mobile step.

## What the keyboard spec covers

One test, seven steps, one connected session. Seats are closed with `closeMember`, which keeps each seat's resume token, so later specs in the same boot reconnect their seats.

1. Keyboard reaches "Describe battlefield (Alt+D)" and "Sort by distance" with a visible focus ring.
2. Move cancel: Enter starts move, ArrowRight previews, Escape cancels; the token does not move; "Movement cancelled." is announced.
3. Move confirm: arrows until "Path cost N feet." is announced; Enter sends it; all three browsers show the active token at the target cell within 1000 ms; the active seat stays active.
4. List-driven: the token table (`Tokens and terrain`) lists the active seat at the same coordinates the map token uses.
5. Alt+D opens the battlefield description keyboard-only.
6. Axe (wcag2a/aa, wcag21a/aa) on the combat screen: no critical or serious violations.
7. Mobile 390x844: "Show map" is reachable by Tab and opens the battle map.

**New in `f624d51`: keyboard-only attack.**

- The fixture (`serve.party.live.ts`) places `ent_goblin-minion_1` at (11,2), next to the first seat's start at (10,2). The step asserts Chebyshev adjacency and fails with the positions if the fixture moves.
- The keyboard runs "Refresh combat options" (options are only sent on explicit request), then Tab to `Attack ent_goblin-minion_1`, then Enter.
- The assertion is on the server frame: a `CombatEvents` frame containing a `RollEvent` whose `actorId` is the active seat. The helper `openMember` now records every JSON frame the page receives.
- The narration log is not the observable. It draws a roll breakdown for save rolls and turn rolls only, so an attack roll never shows as a "Roll breakdown" region. An earlier version of this step asserted on that region and failed with 0.
- Passed in run e2e6.

### Latency

The move-confirm step measures from the confirming keypress until all three browsers show the active token at the target. Run e2e6: 39 ms to all three browsers. Localhost only, so these are not production network numbers.

## Reaction prompt with a PC reactor: blocked, not done

- The fixture stages an opportunity-attack window at boot. `Room.join` calls `declineExpiredReaction` when the pending reactor's seat presence is away, revoked, or unknown (`apps/server/src/room/Room.ts`, around lines 1470-1490). The PC reactor's seat is not connected at boot, so the window is declined on the first join, before the PC sees the prompt.
- The reaction fixture and its spec were removed. Nothing for item 2 is committed.
- To unblock, the fixture needs the reactor seat connected before the window is staged, or a test-only way to stage the window after join. Either is a server-test-harness change that needs a decision.
- Correction to the earlier write-up: the reaction dialog has no `y`/`n` keys. It has Accept and Decline buttons, and Escape declines.

## Area aim (list-driven): implemented, unit-tested, no e2e

- `apps/web/src/features/map/AreaAim.tsx`: a keyboard list (radio group wrapper with `role="group"`; each radio is focusable and handles Escape to clear). Each option has an option ref from `CombatOptions.areas`. A polite live region previews the affected area. "Cast area" sends `{command:'cast', spellId, slotLevel:1, target:{kind:'option', ref}}`; "Cancel area aim" clears it.
- `apps/web/src/screens/Game.tsx` renders `AreaAim` before "End turn".
- `apps/web/test/area-aim.test.tsx`: 9 tests, including jest-axe and compass direction. `game-screen.test.tsx` asserts the area-aim wiring.
- No e2e: the party fixture has no caster with an area spell, so the e2e step is not written. This is the remainder for item 3.

## Move labels (item 5): done

`Game.tsx` labels move buttons as `Move to {x+1},{y+1} ({cost} feet)`, which matches the 1-based letter+number coordinates in the keyboard announcements and the token table. `game-screen.test.tsx` asserts `Move to 3, 3`. Committed in `e865773`.

## Pointer equivalents (item 4): not done

No pointer-equivalent e2e or unit test was added in this branch. Remains open.

## Findings outside this PR's scope

- The engine's options generator (`packages/engine/src/map/options.ts`, around lines 149-165) lists attacks against any target, including allied seats, and does not gate attack options on the action resource. The server still rejects an attack with no action (`combat.ts` checks `resource.action`), so the UI can show an attack the server will refuse. Reported; not changed here.

## Gate status

- Covered: keyboard move preview, cancel, and confirm; focus visibility; list-driven coordinates; Alt+D; axe serious/critical on the combat screen; the 390x844 "Show map" fallback; three-browser sync for one move; keyboard attack against an adjacent goblin.
- Not covered: reaction prompt answered by keyboard in party mode (blocked, see above); area aim e2e (implemented, unit-tested only); pointer equivalents.

## Uncertainties

- Sync numbers come from localhost only.
- `e2e-party/*.ts` is not in the web tsconfig include, so typecheck does not check the specs.
- The `WebServer` log shows `[vite] ws proxy error: read ECONNRESET` and socket errors during the round specs. They appeared after the kick test's socket closed. I did not confirm they are harmless; they did not fail any test.
- Attack resolution is asserted from the server frame, not from a rendered result. The UI does not show attack results or action spend.
- No PR merge, ready-for-review, card assignment, or review was requested or done.
