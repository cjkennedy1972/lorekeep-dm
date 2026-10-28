# ADR-038 scripted live smoke: summary

Summary of the scripted live smoke for ADR-038 story-to-combat (PR #364). The full report is `report-scripted.md` in the Atlas workspace (`atlas/evidence/adr038-smoke/`), outside this repository.

- Source report: `atlas/evidence/adr038-smoke/report-scripted.md` (Atlas workspace)
- Source sha256: `346e9bc2077ea4448396fa5cde577d80f3c8b73ee226ca082ed21e5bcc6f2d1f`
- Smoke head: `b3d63dcef1276e3da1bc0ee09f045744037f2944` (`fix: preserve encounter withdrawal and spawn refs`), a pre-final PR #364 head.
- Later changes: `572e4e6` and `f5b08c9d` changed the rejection-budget withdrawal handling (separate withdrawal store from counters). They are on `main` (squash `ce40cf7`, tree `f5b08c9d`) and are covered by unit and DB tests. They were NOT part of this live smoke. See `git diff b3d63dce f5b08c9d`.
- Flag: `LOREKEEP_ADR_038_STORY_COMBAT=true` on the private API. Default off.
- Scene progression: scripted. The scene was seeded in the database (`scene-marowfell-well` to `scene-warren-gallery`) and the API restarted. The model did not call `close_scene`, so scene progression by the model is not evidenced.

## Verdict

Partial pass.

| Criterion | Result |
|---|---|
| a. `start_combat` offered only in the encounter scene | Pass for the positive case. The negative case (well scene offers no `start_combat`) was not re-run. |
| b. `CombatStarted`, initiative, enemy tokens | Pass, partial. Roll values not inspected. |
| c. Map, initiative, HP come from the executor; HP and dice change through combat events | Run 1 failed: six free-text `attack` calls returned `unknown-entity`. Run 2 passed through the combat action bar (`RollEvent`, `HpChanged`, `ActionSpent`, monster turns, `CombatEnded`). Free-text attack in combat was not re-tested in run 2. Run 1's cause is not confirmed. |
| d. One opening narration | Pass. One `NarrationCompleted` before `CombatStarted`. |
| e. Enemies in authored spawn zone; party in authored party spawn | Enemy pass (`mk_e2_enemy`). Party not as authored: production placement ignores `partySpawnMarkerId` and took the first cell of the party zone (code read). |
| f. Server log has no player text or secrets | Pass in run 1. Not re-checked in run 2. |

## Provocation attempts

Run 1: five provocations. Provocations 1 to 3 were narrated without a call (`CombatNarratedWithoutStart`). Provocation 4 called `start_combat` and started combat. Provocation 5 was a combat turn.

Run 2: `start_combat` was called on provocation 5 (`CombatStarted` at seq 56).

Across the two runs: 2 starts in about 10 provocation attempts.

## Known gaps in the evidence

- Run 2 damage: hero HP went from 6 to 0 with `HpChanged` recording 8. The damage roll shows 6 (die 4 plus 2). The 2-point gap is unexplained and was not reconciled.
- Run 2 combat ended by party defeat. Unarmed strikes dealt 0 damage, so the goblin was never hurt. This reflects the test character build, not an engine fault.
- Test environment deviations: a private Postgres container; a throwaway account inserted directly; `SOLO_OWNER_RESUME_RECOVERY_ENABLED=true` on the private API only; `LLM_ALLOW_LOCAL_HOSTS` for the local endpoint. No product code was changed for the run.

## Not verified

- Negative scene case for criterion a.
- Initiative roll values and HP changes from free-text attacks in combat.
- `close_scene` as a model-driven scene transition.
- Live run against `main` (`ce40cf7`, tree `f5b08c9d`). The rejection-budget changes after `b3d63dce` were not smoke-tested live. Re-run required before a live `main` claim.
