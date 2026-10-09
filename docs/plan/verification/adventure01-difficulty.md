# Adventure #1 encounters vs the approved solo difficulty targets

Card e4746963. Targets: `docs/plan/verification/solo-calibration.md` (approved 2026-10-09): win rate per fight low ≥97%, moderate ≥90%, high ≥75%; for moderate/high the HP band is measured after a 3-fight day with a short rest (moderate 40–65% of max HP lost, high 60–85%); policy v2 baseline.

## Method

* Harness: `packages/engine/src/calibration/adventure01.ts` (`pnpm --filter @game/rules-engine calibrate:adventure01`), reusing SOLO-CAL `buildPc` (v2), `runFight` (open 30×30 arena, foes 40 ft away, fight to the death), `pc.rest('short')` and `mixSeed`. One niced worker, 300 seeds per class × 12 classes = 3,600 fights per encounter (plus 3,600 three-fight days), seed base 20261010 (disjoint from the calibration 20261008 and held-out 20261009 sets). Rates are the mean of the 12 per-class rates, as in SOLO-CAL.
* Level per encounter (`docs/adventures/01-draft.md`, Advancement): E1 L1; E2 L2 (L2 after scenes 2–3); E3 **L3** (owner decision 2026-10-09: the level-3 milestone is awarded after scenes 4–5 and the larder rest, before the boss hall); E4 L3. Claimed label from the draft's intent column: E1 easy=low, E2 moderate, E3 hard=high, E4 hard=high.
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

## Result after (final: owner decisions E1/E3 applied, `adventures/01/adventure.json`)

| Encounter | Level | Claims | Roster now | Win (300 seeds/class) | HP lost in won fights | KO rate | Day: won all 3 | Day HP lost after fight 3 | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | 1 | low ≥97% | 1 giant fire beetle (was 2 giant rat) | **100.0%** | 4% | 0.0% | 100% | 6% | **in band** |
| E2 lookout | 2 | moderate ≥90%, day HP 40–65% | 1 goblin warrior | 90.4% | 26% | 9.7% | 62% | 59% | **in band** (0.4 pt over the line; about ±1 pt sampling error at 3,600 fights, so a borderline pass) |
| E3 Skarrik | **3** (was 2) | high ≥75%, day HP 60–85% | 1 goblin boss | **86.8%** | 35% | 13.2% | 52% | 69% | **in band** |
| E4 warden | 3 | high ≥75%, day HP 60–85% | 1 specter | 89.6% | 35% | 10.6% | 58% | 66% | in band (win above the floor, i.e. easier than the typical high cell; day HP in band) |

All four encounters now meet their claimed band; no residual miss on the averaged metric (see weak classes below).

### Changes versus the first pass (83% / 62%)

* **E1.** Owner: a jackal "might not be the best option but is directionally correct". Measured candidates (60 seeds/class, same harness): jackal 100% (day HP 7%), giant fire beetle 100% (day HP 5%), badger 100% (6%), hyena 97.9% (22%), giant weasel 78.1% (74%). Chosen: **giant fire beetle** (CR 0, 4 HP, AC 13, 10 XP). It is a dungeon vermin, not an open-country animal, so it fits a ruined gatehouse kennel better than a jackal; its natural glow suits the lamp theme of the adventure; it needs no pack/flank tactics the harness doesn't model; and it clears 97% by a wide margin (100.0% at 300 seeds/class), leaving room for the unmodelled map and trap effects. The jackal would have measured the same.
* **E3.** Re-simulated at level 3 (60 seeds/class): boss alone 88.1% / day HP 70%; boss + 1 minion 70.7% / 86% (misses both); boss + 2 minions 48.6% / 95%; boss + 1 warrior 60.6% / 91%. Only the boss alone is in band, so the minions are dropped (this was already the case after the first pass; Skarrik himself is unchanged). Final 300-seed result: 86.8% win, day HP 69%. The level-3 milestone moved from "after scenes 4–6" to "after scenes 4–5 / larder rest", so the party is level 3 on entering the boss hall (adventure.json `scene-tallow-larder` and `scene-boss-hall` text, draft Advancement table, scene 5/6 text and encounter table).
* **Stale text (E2, E4, plus E1/E3).** `adventure.json` scene text and `docs/adventures/01-draft.md` / `01-fact-sheet.md` encounter table, tactics, loot and ritual wording now describe a single lookout, a single warden (specter), a single beetle and a lone Skarrik. Raw combat XP is now 460 (10 + 50 + 200 + 200); the draft's Advancement section no longer claims combat XP reaches level 3, since milestones carry all levels.

Per-class win rate (final):

| Class | E1 | E2 | E3 (L3) | E4 |
| --- | --- | --- | --- | --- |
| barbarian | 100.0% | 100% | 99.7% | 93.3% |
| bard | 100.0% | 98.3% | 99.3% | 97.7% |
| cleric | 100.0% | 97.0% | 98.3% | 98.3% |
| druid | 100.0% | 93.3% | 87.7% | 94.0% |
| fighter | 100.0% | 98.0% | 95.7% | 96.3% |
| monk | 100.0% | 93.7% | 85.0% | 88.7% |
| paladin | 100.0% | 99.3% | 99.3% | 99.3% |
| ranger | 100.0% | 90.3% | 86.7% | 84.7% |
| rogue | 100.0% | 77.7% | 97.0% | 99.0% |
| sorcerer | 100.0% | 85.7% | 80.3% | 93.0% |
| warlock | 100.0% | 67.3% | 32.3% | 42.3% |
| wizard | 100.0% | 84.3% | 79.7% | 88.0% |

First-pass results for reference (E1 giant rat 83.0%, E3 at L2 62.0% / day HP 88%) are replaced by the table above.

## Residual notes

* E2 and E4 are in band only by being a single monster. E4 specter-only is above its floor (89.6% vs 75%); specter + 1 shadow measured 41.7% win (day HP 98%), and specter + 2 shadows (the original) 6%, so there is no count between 1 and 2 that lands on high.
* Weak classes: warlock (32% at E3, 42% at E4, 67% at E2) and to a lesser degree rogue (E2), sorcerer and wizard fall far under the average, as SOLO-CAL predicted ("plays harder solo" note). The averaged cells pass; a warlock solo player will find E2–E4 hard.
* Not modelled: authored maps, cover, flee rules, special abilities, parley/ritual outs, and the beetle's glow (cosmetic).

## Reproduce

```
pnpm --filter @game/rules-engine calibrate:adventure01      # ~2.5 min, one niced worker
TRY="encounter-e2-lookouts=monster:goblin-warrior,monster:goblin-minion" ONLY=encounter-e2-lookouts \
  node packages/engine/dist/calibration/adventure01.js 60  # candidate roster without editing data
```

## Map smoke test

`apps/web/e2e/adventure-maps.spec.ts` (Playwright; also matched for the Firefox and WebKit projects in `playwright.config.ts`, so the CI `browsers` job runs it) loads `/sandbox/map/<mapId>` for `adv01-upper-ruins`, `adv01-warrens` and `adv01-lamp-vault`, asserts the canvas painted and no `pageerror` or console error. The existing Playwright specs live under `apps/web/e2e` (the `tests/e2e` specs are vitest real-server proofs with no browser), so the spec is there. The route `sandbox/map/:mapId` is dev-only (`import.meta.env.DEV`), like `sandbox/combat`.
