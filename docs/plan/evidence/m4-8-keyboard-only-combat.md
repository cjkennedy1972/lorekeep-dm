# M4-8 evidence: keyboard-only party combat (real server), gate 4

Branch `test/m4-8-area-aim-pointer-e2e`, based on `origin/main` at `835d9d3` (#348). Code commit: `7bf71d9ec94251b93b41a68f8d9b8423dd109cd4`.

Gate 4 ("Keyboard-only combat passes") is covered for movement, attack, reaction, and area aim, plus pointer equivalents for movement. The reaction window is fixture-staged, not produced by real play.

## Coverage of the four gate-4 actions

| Action | Spec | Path | Fixture-staged? |
|---|---|---|---|
| Movement (keyboard) | `party-kbd-combat.spec.ts`, `party-combat.spec.ts` | Keyboard focus, move preview, cancel and confirm; three-browser sync | No. Seats start where the seed places them. |
| Movement (pointer) | `party-pointer-move.spec.ts` | Click a reachable cell, then Confirm move; click a cell, then Cancel move. No drag. | No. |
| Attack | `party-kbd-combat.spec.ts` | Keyboard attack on an adjacent goblin, asserted on a `CombatEvents` `RollEvent` with `actorId` of the active seat | The goblin is placed beside the active seat by the fixture (`placeAdjacent`). The attack itself is real play. |
| Reaction (opportunity attack) | `party-kbd-reaction.spec.ts` | Accept (Enter), Decline (Tab, Enter), Escape declines; asserted on `ReactionAnswered` frames | **Yes.** Staged by `POST /api/test/stage-reaction`. |
| Area aim | `party-kbd-area.spec.ts` | Open the AreaAim list, arrow to an aim, read the affected-units preview, Enter casts; Escape clears; Cancel clears | Caster and goblin placement are fixture-seeded (`POST /api/test/reset-area`). The cast resolves through the real engine and server. |

### Why reaction is fixture-staged

Real play cannot reach a PC reactor deterministically:

- A PC moving away from a monster provokes the monster's reaction. The monster has no controller, so the engine auto-declines it. A PC-reactor prompt never appears on that path.
- A PC reactor needs the monster to move, and monster AI timing is not under test control.

`stage-reaction` runs the engine's real `moveAlong` and `applyMovement`, then calls `scheduleReaction`. The window comes from the rules engine. It is staged after all seats have joined, which avoids the `Room.join` rule that declines a window whose reactor is disconnected.

## Area aim (new this PR)

`party-kbd-area.spec.ts`, three tests:

1. **Keyboard cast.** The caster opens the area list, arrows to an aim, and the affected-units preview updates. The first test runs axe on this state with no serious or critical violations. Enter sends a `cast` command whose target is the option `ref` from the latest `CombatOptions.areas` frame. The test asserts the sent frame carries that engine-issued ref, then asserts the server's `CombatEvents` frame contains `SpellCast` and `AreaResolved`.
2. **Escape clears the aim.** Escape on the list clears the selection. No `cast` frame is sent.
3. **Cancel clears the aim.** The "Cancel area aim" button clears the selection. No `cast` frame is sent.

The caster is a valid quick-built wizard (`quickBuild(catalog, 'class:wizard', …)`) with only `spell:burning-hands` prepared, so every area option is Burning Hands. The goblin is placed two cells east of the caster, inside the cone.

## Pointer move (new this PR)

`party-pointer-move.spec.ts`, two tests:

1. Click a free neighbour cell that the map's own preview reports as reachable (`Move preview: … feet`). Then click "Confirm move". The test checks the sent destination and that every seat receives the move within `SYNC_BUDGET_MS`.
2. Click a cell, then "Cancel move". The caster does not move, and no move is sent.

The click uses `canvas#game-map-canvas`'s own `locator.click({ position })`. An earlier version computed page coordinates by hand and clicked the wrong cell, which was a test-helper bug. No product code was changed for it.

## Product changes

None in this PR. The area-aim UI (`AreaAim.tsx`), the pointer path (canvas click → `pickCell` → Confirm/Cancel), and axe on the area state all passed without modification. No UI defect was exposed. The only test-side fixes were the caster sheet (the earlier `hero` fixture fails `validateCharacter`) and the canvas click helper.

## Test-only fixture hooks (`apps/server/test/live/serve.party.live.ts`)

- `POST /api/test/reset-combat` (from #348): restores the seeded combat state.
- `POST /api/test/stage-reaction` (from #348): stages the reaction window.
- `POST /api/test/reset-area` (new): restores the area fixture. Seeds the area table with the caster, guest, and scout seats.
- `placeTwoCellsAway` (new): places the goblin two cells from the caster on a free in-map cell.

## Environment

- Postgres: dedicated, throwaway Docker container `m4-8-area-pg` (postgres 16-alpine) on `127.0.0.1:55483`, database `lorekeep_m48a`, migrated before the run. Removed after the runs with `docker rm -f m4-8-area-pg`. The password was read from a local file and is not committed.
- `DATABASE_URL` was set for the run only.
- Real server: `apps/server/test/live/serve.party.live.ts` (vitest, `LIVE_API_PORT` 8800) and vite on 5176, started by `apps/web/playwright.party.config.ts` (1 worker, chromium).

## Commands and results

All commands ran on commit `7bf71d9`.

| Command | Result |
|---|---|
| `pnpm --filter @game/web typecheck` | exit 0 |
| `pnpm --filter @game/server typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0 |
| `pnpm --filter @game/web test` | 40 files, 316 tests passed, exit 0 |
| `DATABASE_URL=… pnpm exec playwright test -c playwright.party.config.ts e2e-party` (from `apps/web`, one boot, full directory) | **20 passed, 1 skipped** (21 tests), 26.7 s, exit 0 |

The skipped test is `party-round.spec.ts:501`, "an unseated player sees Not seated and can rejoin". It is a pre-existing `test.fixme` on `origin/main`, not a new skip.

Per-spec results in the full run:

- `party-combat.spec.ts`: 1 passed (three-browser keyboard move sync, 52 ms).
- `party-kbd-area.spec.ts`: 3 passed.
- `party-kbd-combat.spec.ts`: 1 passed.
- `party-kbd-reaction.spec.ts`: 3 passed (fixture-staged).
- `party-pointer-move.spec.ts`: 2 passed (pointer sync, 60 ms).
- `party-round.spec.ts`: 10 passed, 1 skipped (pre-existing fixme).

## Uncertainties

- Reaction is fixture-staged, not real play, for the reasons above.
- `e2e-party/*.ts` is not in the web tsconfig include, so typecheck does not check the specs. Eslint and the Playwright run do.
- The WebServer log shows `[vite] ws proxy error: read ECONNRESET` during some round specs. No test failed because of it, and I did not confirm that it is harmless.
- Attack resolution is asserted from the server frame. The UI does not show attack results or action spend.
- Area aim uses Burning Hands only. Other area spells are not exercised on the server.
- Not merged, not marked ready, no review requested.
