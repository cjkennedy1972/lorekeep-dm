# Adventure #1 encounters vs the approved solo difficulty targets

Card e4746963. Targets: `docs/plan/verification/solo-calibration.md` (approved 2026-10-09): win rate per fight low ≥97%, moderate ≥90%, high ≥75%; for moderate/high the HP band is measured after a 3-fight day with a short rest (moderate 40–65% of max HP lost, high 60–85%); policy v2 baseline.

## Method

* Harness: `packages/engine/src/calibration/adventure01.ts` (`pnpm --filter @game/rules-engine calibrate:adventure01`), reusing SOLO-CAL `buildPc` (v2), `runFight` (open 30×30 arena, foes 40 ft away, fight to the death), `pc.rest('short')` and `mixSeed`. One niced worker, 300 seeds per class × 12 classes = 3,600 fights per encounter (plus 3,600 three-fight days), seed base 20261010 (disjoint from the calibration 20261008 and held-out 20261009 sets). Rates are the mean of the 12 per-class rates, as in SOLO-CAL.
* Level per encounter (`docs/adventures/01-draft.md`, Advancement): E1 L1; E2 L2 (L2 after scenes 2–3); E3 L2 (L3 is awarded after scenes 4–6, i.e. after E3); E4 L3. Claimed label from the draft's intent column: E1 easy=low, E2 moderate, E3 hard=high, E4 hard=high.
* "Day" = the same encounter three times with a short rest between (the SOLO-CAL day definition), HP lost after fight 3 (a failed fight ends the day, counting the HP lost there).
* Not modelled (same limits as SOLO-CAL): the authored maps, cover, spawn geometry, flee rules, special abilities (rat/lookout tactics, shadow stealth, Life Drain max-HP reduction), parley/ritual outs. The simulation is the calibration arena, not the authored map.

## Result before (as merged in PR #89, draft rosters)

| Encounter | Level | Claims | Roster | Win | Day HP lost | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 1 | low ≥97% | 2 giant rat | 34% | 95% | miss |
| E2 | 2 | moderate ≥90% | 2 goblin warrior, 2 goblin minion | 10% | 100% | miss |
| E3 | 2 | high ≥75% | goblin boss, 2 goblin minion | 19% | 99% | miss |
| E4 | 3 | high ≥75% | specter, 2 shadow | 6% | 100% | miss |

(100 seeds/class.) The draft used raw SRD XP at 1× "solo", which SOLO-CAL found far too hard; the rosters were never calibrated.

## Result after (monster counts changed in `adventures/01/adventure.json`)

| Encounter | Level | Claims | Roster now | Win (300 seeds/class) | HP lost in won fights | KO rate | Day: won all 3 | Day HP lost after fight 3 | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 rats | 1 | low ≥97% | 1 giant rat | **83.0%** | 26% | 17.5% | 49% | 65% | **MISS win** (−14 pts) |
| E2 lookouts | 2 | moderate ≥90%, day HP 40–65% | 1 goblin warrior | 90.4% | 26% | 9.7% | 62% | 59% | **in band** (90.4% is 0.4 pt over the line; about ±1 pt sampling error at 3,600 fights, so this is a borderline pass) |
| E3 Skarrik | 2 | high ≥75%, day HP 60–85% | goblin boss alone | **62.0%** | 45% | 38.4% | 22% | 88% | **MISS win** (−13 pts) and day HP 88% just over 85% |
| E4 wardens | 3 | high ≥75%, day HP 60–85% | 1 specter | 89.6% | 35% | 10.6% | 58% | 66% | in band (win is above the floor, i.e. easier than the typical high cell; day HP in band) |

Per-class win rate (post): see the final column group below.

| Class | E1 | E2 | E3 | E4 |
| --- | --- | --- | --- | --- |
| barbarian | 99.7% | 100% | 98.7% | 93.3% |
| bard | 88.7% | 98.3% | 77.7% | 97.7% |
| cleric | 89.3% | 97.0% | 82.7% | 98.3% |
| druid | 86.3% | 93.3% | 60.7% | 94.0% |
| fighter | 92.0% | 98.0% | 84.3% | 96.3% |
| monk | 91.0% | 93.7% | 64.3% | 88.7% |
| paladin | 88.3% | 99.3% | 94.7% | 99.3% |
| ranger | 82.3% | 90.3% | 60.3% | 84.7% |
| rogue | 67.3% | 77.7% | 26.7% | 99.0% |
| sorcerer | 73.7% | 85.7% | 37.0% | 93.0% |
| warlock | 58.3% | 67.3% | 14.0% | 42.3% |
| wizard | 79.3% | 84.3% | 42.7% | 88.0% |

## Residual misses and why counts cannot fix them

* **E1:** the lowest legal roster (one giant rat, 25 XP, +5 to hit, 1d4+3) wins 83% against the L1 average PC. SOLO-CAL's L1 `low` cell is a 10 XP monster (jackal-class). One rat cannot be reduced further. Measured alternatives (60 seeds/class, same harness): 1 jackal 100% (day HP 7%), 2 jackals 97.6%. Reaching "low" at L1 needs a weaker creature than the giant rat, i.e. a content decision (rename the colony, or use jackals/vermin), not a count change.
* **E3:** Skarrik alone (CR 1, 21 HP, AC 17) wins 62%, 13 points under high and the day HP (88%) is just above the band. Dropping the boss's minions already took it from 19% to 62%; the only count-only options below that remove the boss: 2 goblin minions 81.5% (day HP 76%), 1 goblin warrior 91.9%. Both delete Skarrik, who anchors scene 6 and the key/breastplate canon, so I did not apply them. Alternative: move E3 to level 3 (the PC becomes L3 after scenes 4–6 only by milestone) or award the level-3 milestone before the boss hall.
* **E2 and E4** are in band only by being a single monster; "lookouts" and "wardens" are now one creature each. E4 specter-only is above its floor (89.6% vs 75%); specter + 1 shadow measured 41.7% win (day HP 98%), which is a deadly-band encounter, and specter + 2 shadows (the original) 6%. There is no count between 1 and 2 that lands on high.
* Weak classes: warlock (and rogue/sorcerer/wizard at E3) fall far under the average at every encounter, as SOLO-CAL predicted ("plays harder solo" note).
* Narrative text still names the plural ("goblin lookouts", "three shapes of bound dead") in `adventures/01` scene text and `docs/adventures/01-draft.md`; scene text was not edited (out of scope), the draft's encounter table is stale for the four rosters.

## Reproduce

```
pnpm --filter @game/rules-engine calibrate:adventure01      # ~2.5 min, one niced worker
TRY="encounter-e2-lookouts=monster:goblin-warrior,monster:goblin-minion" ONLY=encounter-e2-lookouts \
  node packages/engine/dist/calibration/adventure01.js 60  # candidate roster without editing data
```

## Map smoke test

`apps/web/e2e/adventure-maps.spec.ts` (Playwright; also matched for the Firefox and WebKit projects in `playwright.config.ts`, so the CI `browsers` job runs it) loads `/sandbox/map/<mapId>` for `adv01-upper-ruins`, `adv01-warrens` and `adv01-lamp-vault`, asserts the canvas painted and no `pageerror` or console error. The existing Playwright specs live under `apps/web/e2e` (the `tests/e2e` specs are vitest real-server proofs with no browser), so the spec is there. The route `sandbox/map/:mapId` is dev-only (`import.meta.env.DEV`), like `sandbox/combat`.
