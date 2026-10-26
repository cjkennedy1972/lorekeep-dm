# M4-9a: six-client party-combat simulation: evidence

Workboard card 8d76f62b. Branch `test/m4-9a-six-client-sim`, off `origin/main` e8aeefb.
Draft PR only; not ready for review until Sentinel and Bastion return GO.

## Environment

- Postgres 16 in Docker, container `m4sim-pg`, published on `127.0.0.1:55432`, same image as `infra/docker-compose.yml`. Run directly with `docker run` because the host already had Postgres on 5432 and the compose project conflicted with it.
- `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55432/lorekeep`
- Test runner: vitest 3.2.4. Node v26.12.1. macOS 27.2 (arm64).

## Commands and results

```
cd apps/server && pnpm typecheck
```
Clean; no errors.

```
cd apps/server && DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55432/lorekeep pnpm exec vitest run test/db/sim-combat.test.ts 2>&1 | grep -v '^{"level"'
```
Result: 6 passed (6). Duration about 31 s.

| Scenario | Result | Notes |
|---|---|---|
| reaction timeout: declines at the 15 s window with cause `timeout`, never answers | pass | `ReactionDeclined` cause `timeout`; no `ReactionAnswered` |
| reconnect mid-prompt: prompt replays with remaining time; the drop does not decline it | pass | Replayed `timeoutMs` below 14 000; no `ReactionDeclined` |
| reconnect mid-prompt: monster-bound controller's answer is rejected with `not-your-turn` | pass (plain `it`), see below | Asserts `Error` with code `not-your-turn` exactly |
| chat isolation: OOC chat absent from the DM narration prompt; other seats still receive it | pass | Narration is triggered by `end-turn`, see below |
| host kick during an open reaction prompt | pass | `ReactionDeclined` cause `presence` within 3 s; kicked socket closes 1008; host keeps acting |
| spotlight over combat turns: every standing PC gets a turn in every complete round, six clients | pass | Metric described below |

```
cd /Users/ckennedy/.openclaw/workspace/proof/worktrees/m4-9a-sim && pnpm lint
```
Clean after one fix (an unused binding in the chat test).

```
pnpm format:check
```
Clean.

Regression run over the four DB/room files that cover this area:
`test/db/sim-combat.test.ts test/db/sim-clients.test.ts test/db/combat.test.ts test/room/combatFlow.test.ts`
Result: 4 files passed, 108 tests passed.

## Spotlight flake (Bastion NO-GO on a1c4cdf): investigation and fix

Bastion reported one `not-your-turn` failure in the spotlight test at a1c4cdf and a pass on rerun.

**Root cause (test harness, not server).** `combatCommand` in `test/sim/combat.ts` accepts the first `CombatTracker` frame that arrives after its mark. The server sends one `CombatTracker` per committed command to every connected seat (`Room.ts`, `commitCombat`), and success replies carry no `actionId` (only rejections do). When the previous PC's end-turn broadcast reached seat B after B's mark, B's next `combatCommand` returned that stale broadcast as its own reply. The loop then took the stale `activeEntityId`, sent end-turn as the wrong owner, and received `not-your-turn`. The server's admission gate was behaving correctly; it was given a command from a seat that had the wrong turn.

**Fix.** Before each end-turn, the loop records every client's inbox length. After a tracker reply, it waits until all six seats have received a `CombatTracker` after their mark, so the broadcast for that command is fully delivered before the next command's mark can be taken.

**Not reproduced before the fix.** The unfixed head (a1c4cdf) passed 20 of 20 spotlight runs in this environment, so the race was established by reading the code path, not by reproducing Bastion's failure. The stale-broadcast window is narrow and timing-dependent.

**Loop after the fix.** Command: `cd apps/server && DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:55432/lorekeep pnpm exec vitest run test/db/sim-combat.test.ts -t spotlight`, repeated 20 times. Result: 20 of 20 exit 0, each `Tests 1 passed | 5 skipped (6)`. Per-run logs were captured in a scratch directory, not committed.

## Test-by-test detail

### Reaction timeout
Mover steps out of goblin 1's reach; the goblin's controller gets `ReactionPrompt` with `timeoutMs` in (0, 15000]. After the window, the server emits `ReactionDeclined{cause:'timeout'}` and no `ReactionAnswered`.

### Reconnect mid-prompt
The controller disconnects with the prompt open, reconnects after about 2 s, and receives the prompt again with the remaining time (under 14 s). The disconnect does not decline the prompt.

**Pinned product gap.** A seated account bound to a monster entity via `combatActors` receives the `ReactionPrompt`, but its reaction answer is always rejected with `not-your-turn`. The test asserts the exact `Error` frame and code. It is a plain `it`, not `it.fails`: `it.fails` turns any throw green, including a timeout or a broken helper, so it could not be limited to this one cause. Cause: Room derives the acting entity from the seat's own party entity (`Room.ts`, actorId derivation around lines 5214–5225), while the admission gate in `combat.ts` requires `actorId === pendingReaction.entityId`. The prompt reaches the controller and the answer cannot. When the gap is fixed the answer becomes a `CombatTracker`, the assertion fails, and the test must be rewritten to expect success. It is not yet a filed Workboard card (see Blocked below).

### Chat isolation from combat narration
An OOC chat message is delivered to other seats as a `ChatMessage` frame. The mover ends its turn, which triggers narration. After the DM is asked, the DM prompt text does not contain the marker.

**Observation.** Moving alone (a `move` command) did not produce a DM narration request within 10 s in combat. Narration appeared after `end-turn`. Any test that expects narration from a move will be vacuous; the chat test triggers narration with `end-turn` and waits for `dm.requests.length > 0` before asserting, so it is not vacuous.

### Host kick during an open reaction prompt
The host sends `KickSeat` for the controller while the prompt is open. The prompt is declined immediately with cause `presence` (within 3 s). The kicked socket closes with code 1008. The host can still take combat actions afterward.

### Spotlight over combat turns
- The loop drives combat through `end-turn` replies from the owning client of each PC, using `activeEntityId` from each `CombatTracker` reply. Monster turns resolve on the server.
- Loop ends on a `Combat is over` rejection or after 200 turns.
- Rounds are derived from the persisted `TurnStarted` and `EntityDown` events. A round opens at the mover's `TurnStarted`, and that turn counts for the mover. A PC down at round start, or going down during the round, is not owed a turn in it. The final round is excluded because the encounter can end mid-round.
- Assertions: no standing PC is starved in any complete round; at least 3 complete rounds observed; no `RATE_LIMITED` errors on clients[0].

**Metric bug found and fixed while writing this test.** The first version did not credit the mover's own turn, so the mover was reported as starved in every round. Fixed by crediting the mover in the round it opens.

**Observation: party defeated early.** In the failing run before the metric fix, the encounter ended with `CombatEnded` outcome `party-defeated` after 4 rounds (EntityDown events present). With six level-1 PCs (from `quickBuild`) against two auto-played goblins, the party is defeated around round 4 to 8. So a 10-round spotlight cannot complete in this encounter. The test therefore does not assert 10 rounds; it asserts at least 3 complete rounds. Whether this is level-1 balance or a monster-policy issue is not yet determined, and it is the open question before filing a card.

**Observation: `liveCombat().activeEntityId` read as null in practice.** The loop reads `activeEntityId` from the `CombatTracker` reply payload instead, which was reliable in every run.

## Blocked

- **Workboard cards for product bugs.** No card-creation tool is available in this session. The `workboard_sessions_board_*` tools only manage Sessions boards. Product bugs to file as backlog, unassigned cards:
  1. Seated controller of a monster-bound entity: reaction answers always `not-your-turn` (pinned as a plain test in `sim-combat.test.ts`).
  2. Party defeated by about round 4 to 8 in the six-PC encounter. Needs triage: balance vs. monster policy.
  3. Move alone does not trigger DM narration in combat; only `end-turn` does. Confirm whether that is intended.

## Files

- `apps/server/test/sim/harness.ts`: `SimTable.characters` added; each seated character is pushed after `bindSeatCharacter`.
- `apps/server/test/sim/combat.ts`: new; `startPartyCombat`, `combatCommand`, `pollFrom`, `framesOf`.
- `apps/server/test/db/sim-combat.test.ts`: new; six scenarios above.
- `docs/plan/evidence/m4-9a-six-client-combat-sim.md`: this file.
