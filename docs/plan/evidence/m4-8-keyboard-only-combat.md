# M4-8 evidence: keyboard-only party combat (real server), PARTIAL for gate 4

Branch `test/m4-8-kbd-reaction`, based on a fresh `origin/main`. Draft PR opened from this branch. It does not replace any merged work; it adds the keyboard opportunity-attack reaction e2e and a fixture fix that makes the attack e2e deterministic.

Scope: gate 4 is partly covered. Keyboard move, attack, and the opportunity-attack reaction (Accept, Decline, Escape) are covered end to end on the real party server. The reaction window is staged by a test-only fixture hook, not by real play (see below). Area aim has unit tests only. Pointer equivalents are not done.

## Environment

- Postgres: a dedicated, throwaway Docker container `m4-8-kbd-reaction-pg` (postgres 16) on 127.0.0.1:55481, database `lorekeep_m48r`, migrated before the run. Removed with `docker rm -f m4-8-kbd-reaction-pg` after the runs.
- `DATABASE_URL` was set to that container's URL for the run only. The URL is not committed.
- Real server: `apps/server/test/live/serve.party.live.ts` (vitest, LIVE_PORT 8800) plus vite on 5176, started by `apps/web/playwright.party.config.ts` (1 worker, chromium, 0 retries).
- All commands ran in one server boot, in this order, on the same commit.

## Commands and results

| Command | Result |
|---|---|
| `pnpm --filter @game/web typecheck` | exit 0 |
| `pnpm --filter @game/server typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm format:check` | exit 0 (after `prettier --write` on the changed files) |
| `pnpm --filter @game/web test` | 40 files, 316 tests passed |
| `DATABASE_URL=postgres://postgres:…@127.0.0.1:55481/lorekeep_m48r pnpm exec playwright test -c playwright.party.config.ts e2e-party/` (whole directory, from `apps/web`) | **15 passed, 1 skipped**, 19.9 s, exit 0 |

The one skipped test is the pre-existing `test.fixme` "an unseated player sees Not seated and can rejoin". It is not a new skip.

The 15 passed include the three new reaction tests (`party-kbd-reaction.spec.ts`), the keyboard combat test, and the existing party round and host specs.

## Keyboard opportunity-attack reaction (new)

`apps/web/e2e-party/party-kbd-reaction.spec.ts`, three tests. Each test opens three seats (host, guest, scout) and stages the window after all three are connected.

1. **Accept by keyboard.** The reactor gets a `ReactionPrompt` frame with options `['take', 'decline']` and the reactor's dialog is focused on Accept. Enter sends `take`. The server frame `ReactionAnswered{choice:'take'}` confirms it. Non-reactor seats get a `ReactionPromptOpen` frame, show the status "Reaction window open for <entity>", and have no dialog.
2. **Decline by keyboard.** Tab moves focus to Decline and Enter sends it. Frame: `ReactionAnswered{choice:'decline'}`. No `take` frame.
3. **Escape declines.** Escape on the dialog sends `decline`. Frame: `ReactionAnswered{choice:'decline'}`.

In each test all seats' dialogs close after the answer. The assertions are on server frames, not on rendered text alone.

### Why the window is staged, not played

The brief asked for real play first. It is not reachable deterministically, for two reasons:

- A PC moving away from a monster provokes the monster's reaction. That monster reactor has no controller, so the engine auto-declines it. The real provoking path therefore never produces a PC-reactor prompt.
- A PC reactor needs the monster to move. That monster move depends on monster AI, so its timing is not under test control.

The fixture therefore stages the window after all seats have joined. `POST /api/test/stage-reaction` (test-only, `serve.party.live.ts`):

- puts the goblin adjacent to the reactor, sets the goblin's turn resources, and finds a cell two squares away from the reactor;
- runs the engine's real `moveAlong` and `applyMovement`, so the window is produced by the rules engine, not by writing a prompt directly;
- persists the state and calls the Room's `scheduleReaction`.

Staging after join avoids `Room.join`'s rule that declines a window whose reactor seat is not connected (`apps/server/src/room/Room.ts`, around lines 1470-1490). No product code was changed.

## Keyboard-only attack (fixed in this branch)

`party-kbd-combat.spec.ts` has one test with seven steps (focus, move cancel, move confirm with three-browser sync, token-list coordinates, Alt+D, axe on the combat screen, and the 390x844 "Show map" fallback), plus a keyboard attack on an adjacent goblin. The attack is asserted on a `CombatEvents` frame with a `RollEvent` whose `actorId` is the active seat.

**Pre-existing flake, fixed.** The attack step failed with "goblin is adjacent to the active seat" (expected 1, received 2) when run after `party-combat.spec.ts`. Two causes:

- The fixture placed the goblin at a fixed cell (11,2). Seat start positions are random, so the goblin was sometimes not beside the acting seat.
- Earlier specs in the same server boot left the shared combat table in a moved state.

Fix:
- The goblin is placed beside the active entity (`placeAdjacent`) when the table is seeded.
- A new test-only `POST /api/test/reset-combat` restores the seeded combat state. `openCombatTable` in `party-kbd-combat.spec.ts` calls it before the test.
- The adjacency assertion is kept, so a future fixture regression fails loudly.

## Cross-spec reconnect (harness, from earlier work)

Seats in later specs of the same boot reconnect with a saved `storageState` (`openMember` / `closeMember` in `combat-helpers.ts`). The resume token lives in localStorage, so a fresh context without it looks like a new device and needs host approval. This is the intended path; the harness keeps the token.

## Move labels

`Game.tsx` labels move buttons `Move to {x+1},{y+1} ({cost} feet)`, matching the 1-based coordinates in keyboard announcements and the token table. Covered by `game-screen.test.tsx`.

## Area aim: implemented, unit tests only

`apps/web/src/features/map/AreaAim.tsx` is a keyboard list over `CombatOptions.areas`. `apps/web/test/area-aim.test.tsx` has 9 unit tests. There is no e2e: the party fixture has no caster with an area spell.

## Pointer equivalents: not done

No pointer-equivalent e2e or unit test was added.

## Findings outside this PR's scope

- The engine's options generator (`packages/engine/src/map/options.ts`, around lines 149-165) lists attacks against any target, including allied seats, and does not gate attack options on the action resource. The server still rejects an attack with no action (`combat.ts` checks `resource.action`), so the UI can offer an attack the server will refuse. Not changed here.
- The reaction prompt has no `y`/`n` keys. It has Accept and Decline buttons, and Escape declines. This is the intended design.

## Uncertainties

- The reaction is fixture-staged, not real play. Real play is not deterministic for the reasons above.
- `e2e-party/*.ts` is not in the web tsconfig include, so typecheck does not check the specs; eslint and the Playwright run do.
- The WebServer log shows `[vite] ws proxy error: read ECONNRESET` during some round specs. They did not fail any test; I did not confirm they are harmless.
- Attack resolution is asserted from the server frame. The UI does not show attack results or action spend.
- Sync latency numbers from earlier runs (31-40 ms, localhost only) are not re-measured in this run and are not repeated here.
- Not merged, not marked ready, no review requested.

## Gate status

- Covered: keyboard move preview, cancel, and confirm; focus visibility; list-driven coordinates; Alt+D; axe serious/critical on the combat screen; the 390x844 "Show map" fallback; keyboard attack against an adjacent goblin; keyboard reaction Accept, Decline, and Escape with server-frame assertions; 1-based move labels.
- Not covered: reaction via real play (fixture-staged instead); area aim e2e (unit-tested only); pointer equivalents.
- Card `d7e5752e` remains open for area aim e2e and pointer equivalents.
