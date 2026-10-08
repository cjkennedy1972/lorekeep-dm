# M2-06 scenario variety: scripted combats and golden replays

Spec: `docs/plan/m2-tasks.json` M2-06. Suite: `tests/e2e/m2-scenarios.spec.ts` (59 tests). Goldens: `tests/e2e/golden/m2-<scenario>.seed-<seed>.json`.
Harness: `packages/engine/src/scripted/sim.ts` (generic runner) and `scenarios-m2.ts` (eight scenarios), exported through `@game/rules-engine/scripted-node`. No LLM, no network.

Run: `pnpm --filter @game/e2e exec vitest run m2-scenarios`. Regenerate a golden only after a deliberate engine change: `UPDATE_GOLDEN=1 ...` then read the diff. A divergence fails with the first differing event index and both neighbourhoods (`diffLogs`, itself tested by tampering with a roll).

## How the harness works

`Sim` threads one seeded RNG through the real engine calls (`attack`, `castSpell`, `concentrationSave`, `deathSave`, `contestedCheck`, `moveAlong`/`resolveReaction`, `startTurnWithConditions`, `monsterPolicy`). Every observable fact lives in `SimState`, which is a pure fold (`reduceSim`) over the event log, so `replaySim(events)` rebuilds the final state from the log alone and is compared to the live state. Foes are built from SRD catalog stats (`monster:*`); PCs are fixtures (not `quickBuild` output). Harness-level rules, not engine behaviour: initiative order, dying/stable/dead status, auto-fail death saves on damage at 0 HP, concentration saves after damage, ranged attack with a hostile within 5 ft has disadvantage, door opening, stand-up costs half speed, Disengage, grapple/shove as a contested check.

## Scenarios and why each golden is correct

Seeds were found by searching for one that exercises the intended rule (predicates in the PR description); each outcome was then read event by event.

| Scenario (seed) | Map | Ends | What the reviewed log shows |
| --- | --- | --- | --- |
| `kiting-cover-v1` (3136) | crypt | round-cap, archer 1 HP, one goblin dead, one at 6 HP | Archer shoots from 80 ft range, Disengages (no `OpportunityTriggered`, as intended) when a goblin closes, and a shot through the pillar is refused (`AttackRefused`, full cover). Goblins `approach` and `attack`; the wounded one `flee`s. Its three shots (70, 75 and 10 ft) all have no hostile within 5 ft, so the adjacent-disadvantage rule is not exercised here. The fight stalls at the round cap because the fleeing goblin stays away. |
| `door-rubble-v1` (3102) | crypt + partition wall, closed door at x=9 | foes defeated | No foe `EntityMoved` before `DoorOpened` (the policy `hold`s with no route). After the PC opens it (must be within 5 ft), foes cross the rubble: steps cost 10 ft, plain floor 5 ft. Two foes provoke opportunity attacks: the skeleton dies to the archer's reaction, and the zombie dies to the fighter's, after which the archer's pending reaction resolves `used: false` with no attack on the corpse (the fix in defect 2). |
| `concentration-v1` (3106) | crypt | foes defeated | Wizard concentrates on Hideous Laughter. Goblin hit for 6: DC = max(10, 6/2) = 10, d20+2 failed, `ConcentrationDropped`. Recast, target gets incapacitated+prone with a spell-sourced tag. Wizard falls to 0 HP: concentration ends and both conditions are removed. |
| `fireball-partial-v1` (3103) | forest | foes defeated | Level-5 wizard (DC 8+3+3 = 14) aims at the densest cluster: `AreaResolved` affects 3 of 5 foes; the two at x=22-23 are outside the 20 ft radius and untouched. Saves 4 and 13 fail (full damage), 17 succeeds (half: floor(31/2) = 15, correct). Cantrips scale to 2d10 at level 5. |
| `death-saves-stable-v1` (3112) | crypt | foes defeated | Dying cleric rolls 19, 18, 16: three successes, `stable`, still unconscious at 0 HP (correct for stable). Fighter kills the fleeing goblin meanwhile. |
| `death-saves-dead-v1` (3101) | crypt | foes defeated | One failed save (6), then an adjacent goblin hits the dying cleric: a hit from within 5 ft is a critical hit (5.2.1 Unconscious), two failures, 3 total, dead. Attack rolled with advantage (two dice). |
| `grapple-prone-v1` (3124) | crypt | foes defeated | Bandit's grapple contest lost (9 v 18), later won (18 v 13): `grappled`, speed 0 (`MovementSpent 30`, then `MoveRefused`). Escape contest 14 v 10 removes it. Wolf bite on a Medium target applies prone; crawling costs double (10 ft per square), standing costs 15 ft (half of 30). |
| `forest-4v6-v1` (3106) | forest | foes defeated | Four PCs (fighter, archer, wizard, cleric) vs four goblin warriors and two minions, ten combatants; foes approach 60+ ft across open ground, wounded ones flee. PCs win in 3 rounds, which is plausible for a medium encounter against 10 HP foes. |

Across the set: `OpportunityTriggered`, `AreaResolved`, `DeathSave` (stable and dead), `ConditionApplied`/`ConditionRemoved`, `ConcentrationDropped`, `DoorOpened`, and foe `PolicyDecision` of approach, attack and flee.

## Engine defects found

1. **`monsterPolicy` could never approach or flee (fixed).** `path()` prunes by remaining movement and the policy passed no budget, so every route was "unreachable" and a monster not already in reach returned `hold`. This is why M1-41 never exercised a surviving goblin's turn. Fix: route with unlimited budget and cut the result to the monster's speed. Regression: `packages/engine/test/policy-m2.test.ts` (3 failed before the fix). Side effect: `scenario-crypt.ts` still ran the policy for goblins that were already dead, which now made them walk; it skips downed monsters, so the M1 golden is byte-identical.
2. **Opportunity attacks on and by the downed (fixed).** (a) A second pending reaction was still resolved after the first killed the mover, so a corpse was attacked (`HpChanged 0 -> 0`, seen in `door-rubble`). (b) A hostile at 0 HP could still take an opportunity attack. Fix in `map/movement.ts`; regressions in `packages/engine/test/movement-oa-dead.test.ts` (both failed before).
3. **Area spell damage is rolled once per target (open, not fixed).** In `fireball-partial-v1` the three victims got different 8d6 totals (20, 21, 31). The 5.1 rule is one roll for all targets; I did not confirm the 5.2.1 wording, and fixing it changes the M1 golden, so it is left for a decision.

## Not covered

- Cover that is partial: no log contains a `half` or `three-quarters` grade. The pillar case is full cover (shot refused); a target behind a tree was not arranged because initiative decides who moves first.
- Flying, hidden/invisible creatures, surprise, mounted combat, multi-cell (Large) creatures, reach weapons, lighting.
- Foes never target a dying PC (the policy skips 0 HP targets), so in the forest and fireball runs downed PCs are not finished off. Damage at 0 HP is exercised only by the scripted goblin in `death-saves-dead`. Massive-damage instant death is not modelled.
- Grapple and shove use the 5.1-style contested check (`contestedCheck`); the 5.2.1 grapple is a saving throw against a DC. Grapple escape and shove are harness glue, not engine commands.
- Hideous Laughter's repeat save each turn; spell slots recovery; bonus actions; multiattack; ranged foes; healing and stabilising actions (Spare the Dying, Medicine).
- Doors: only closed-to-open, with no lock, unlock or close.
- Dead bodies do not block movement (dead entities are dropped from the movement state).
- PC fixtures are hand-written, not produced by `quickBuild`.
- No mutation test of the new specs beyond the tampered-roll check of the diff helper.
