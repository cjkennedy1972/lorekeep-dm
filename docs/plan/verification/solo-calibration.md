# Solo difficulty calibration (SOLO-CAL)

Status: **fitted and verified in simulation; the targets and two design choices below are pending human approval.**
The SRD (5.2.1 p. 202) gives a one-character XP budget (75/150/225/375/750 at levels 1–5, moderate) and no solo adjustment. This work derives one from evidence.

## Method

1. **Average character at level L** = the unweighted mean over all 12 classes' M2-05 quick-build PCs at level L. Every rate below is the mean of 12 per-class rates, not a pooled fight rate. Per-class spread is reported (last table).
2. **PC model** (`packages/engine/src/calibration/pc.ts`). Quick build supplies abilities, HP, slots and spells. The sheet has no gear, so each class gets the armor and weapons of its SRD starting-equipment option A. Modelled: Extra Attack, Rage, Second Wind, Action Surge, Lay on Hands, Divine Smite, Sneak Attack/Steady Aim, Martial Arts bonus strike, damage and healing spells (healing below 33% HP), slot and resource tracking across a day, short-rest recovery.
   Three policy versions: **v0** weapon only (no spells, no features); **v1** the quick build's default spells plus features; **v2** best action-cast non-concentration damage/healing spells on the class list (cantrips at 60 ft+), Mage Armor for wizard/sorcerer, focus-fire on the weakest adjacent foe. **Calibration uses v2** (closest to a competent player); v0/v1 are the sensitivity bounds.
3. **Foes** are catalog monsters from the M2-32 builder with their primary attack repeated per Multiattack; they close and fight to the death, with no special abilities, no fleeing, no retreat. The arena is an open 30×30 field, foes start 40 ft away.
4. **Fit** (`select.ts`): seeded fights (`CALIBRATION_SEED` 20261008) for every class × level 1–5 × 18 multipliers (0.2–4× the moderate budget) × enemy cap {1, 2, 3, none}; 60 seeds per class cell (4,320 cells, 259,200 fights, full resources, single fight). For each (level, label) the chosen cell is: inside the whole band → the one spending the most XP; otherwise the win-rate band is the hard constraint and the HP-lost band is soft (least win gap, then least HP gap, then most XP).
   *This lexicographic rule was fixed after seeing that the joint bands are unreachable (see Findings); it was not tuned to flatter a result, and cells that miss are flagged* **no** *in the table.*
5. **Verification** on a disjoint seed set (`HELDOUT_SEED` 20261009) through the shipped path (`buildEncounter` with the table label and multiplier): 100 seeds/class single fights, 40 seeds/class for the 3-encounter sequences and for v0/v1.
6. **Uncertainty**: Wilson 95% intervals on the pooled held-out win rate (1,200 fights per cell, so about ±2–3 points). Fit-vs-held-out gaps (winner's curse from picking the best of 72 candidates) are the larger error: up to about 3 points.

## Targets (pending human approval)

| Label | Win rate | HP lost in won fights | Why |
| --- | --- | --- | --- |
| low (easy) | ≥ 97% | < 35% | A routine fight a player does not worry about; losing here should be a fluke. |
| moderate | ≥ 90% | 40–65% | The SRD intent: the party wins, resources matter. |
| high (hard) | ≥ 75% | 60–85% | Real chance of a down or a loss, still favoured. |
| deadly | 35–60% | unconstrained | Coin flip; a solo PC should be able to die. `deadly` has no SRD row; it scales the SRD High row. |

## Findings

* **The SRD 1× solo budget is far too hard.** At 1× moderate with no cap the average PC (v2) wins 22%, 13%, 23%, 5% and 15% of single fights at levels 1–5 (coarse sweep, 20 seeds per class; the builder then fields 3.3–7.8 enemies). The budget ignores action economy: the greedy builder spends it on 3–8 weak monsters, each of which gets a turn against one PC.
* **A solo budget is a count cap plus a lower multiplier**, roughly 0.2–0.6× the SRD row for low/moderate/high with 1–3 enemies, and about 0.8–1.1× the High row with 1–2 enemies for deadly.
* **The joint win/HP bands are unreachable for moderate and high at every level.** Fights are bimodal: the PC either wins fast with little damage or is overwhelmed. A ≥ 90% win costs about 20–36% of max HP, not 40–65%; a ≥ 75% win costs about 28–47%, not 60–85%. Low and deadly bands are met at every level on the fitted seeds. Moderate and high meet the **win** side at most levels and miss the **HP** side, flagged in the table. (Held-out: L2 high 75% and L3 high 74% sit at or just under the 75% line.)
* **The HP band is met over a day instead.** In a 3-encounter sequence with one short rest, a moderate level ends with 39–66% max HP lost after fight 3 (table below), and the PC wins all three only 55–75% of the time. Without a rest it is 34–60%. So "moderate = 40–65% HP lost" describes a 3-fight day, not a single fight. This is the main design question for the human (decision 1).
* **Legal catalog monsters limit separation at low levels.** At L1–L3 the eligible monsters are a few CR 0–½ creatures (10/25/50/100 XP), so moderate and high differ mostly by one extra weak enemy (L1: both 30 XP, caps 2 vs 3). Higher levels separate better.
* **Class spread is large.** Warlock (65% at moderate) is a clear outlier, then wizard (82%) and sorcerer (87%); barbarian, fighter and paladin sit at 98–100%. The average is dragged down by squishy casters, so an encounter that is "moderate" for the average class is a coin flip for a warlock and trivial for a barbarian. Warlock is under-modelled (no Agonizing Blast, no Hex), so the true spread is probably narrower; either way a single table cannot serve all classes.
* **Policy quality matters a lot.** Single-fight win rates at the shipped moderate cells fall from v2 91–93% to v1 71–88% to v0 30–78% (levels 1–5, table below), mostly from spellcasters. v2 is itself weaker than a competent human (below), so the table is, if anything, **slightly easy for a skilled player**.

## Results

<!-- generated:begin -->

### Calibration table (what the builder loads)

| Level | Label | Multiplier (x SRD row) | Enemy cap | Absolute XP budget | Fitted inside band? | Held-out win (95% CI) | Held-out HP lost in wins | Held-out KO rate | Avg enemies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | low | 0.3 | 1 | 15 | yes | 100% (99%–100%) | 6% | 1% | 1.0 |
| 1 | moderate | 0.4 | 2 | 30 | **no** | 92% (90%–93%) | 20% | 8% | 1.6 |
| 1 | high | 0.3 | 3 | 30 | **no** | 86% (84%–88%) | 28% | 14% | 2.2 |
| 1 | deadly | 1.1201 | 1 | 112 | yes | 48% (45%–51%) | 35% | 53% | 1.0 |
| 2 | low | 0.3 | 2 | 30 | yes | 99% (98%–99%) | 15% | 1% | 1.6 |
| 2 | moderate | 0.2467 | 3 | 37 | **no** | 93% (91%–94%) | 28% | 8% | 2.4 |
| 2 | high | 0.225 | 3 | 45 | **no** | 75% (73%–77%) | 43% | 26% | 3.0 |
| 2 | deadly | 1.125 | 1 | 225 | yes | 51% (48%–54%) | 44% | 50% | 1.0 |
| 3 | low | 0.3734 | 1 | 56 | yes | 97% (96%–98%) | 21% | 3% | 1.0 |
| 3 | moderate | 0.2 | 3 | 45 | **no** | 93% (91%–94%) | 35% | 7% | 3.0 |
| 3 | high | 0.225 | 3 | 90 | **no** | 74% (71%–76%) | 47% | 26% | 3.0 |
| 3 | deadly | 1.125 | 2 | 450 | yes | 44% (41%–47%) | 50% | 56% | 1.8 |
| 4 | low | 0.3 | 1 | 75 | yes | 99% (99%–100%) | 15% | 1% | 1.0 |
| 4 | moderate | 0.2 | none | 75 | **no** | 91% (89%–93%) | 36% | 9% | 3.2 |
| 4 | high | 0.524 | 2 | 262 | **no** | 78% (75%–80%) | 46% | 22% | 2.0 |
| 4 | deadly | 0.974 | 1 | 487 | yes | 52% (49%–55%) | 50% | 48% | 1.0 |
| 5 | low | 0.45 | 1 | 225 | yes | 99% (99%–100%) | 20% | 1% | 1.0 |
| 5 | moderate | 0.6 | 2 | 450 | **no** | 91% (90%–93%) | 35% | 9% | 1.8 |
| 5 | high | 0.4091 | 3 | 450 | **no** | 81% (79%–83%) | 44% | 19% | 2.5 |
| 5 | deadly | 0.7837 | 2 | 862 | yes | 41% (39%–44%) | 55% | 59% | 2.0 |

### Targets used (pending human approval)

| Label | Win rate | HP lost in won fights |
| --- | --- | --- |
| low | ≥ 97% | < 35% |
| moderate | ≥ 90% | 40%–65% |
| high | ≥ 75% | 60%–85% |
| deadly | 35%–60% | unconstrained |

### Three encounters in a row (held-out seeds, same cells)

| Level | Label | Won all 3, short rest between | Won all 3, no rest | HP lost after fight 3 (short rest) |
| --- | --- | --- | --- | --- |
| 1 | low | 98% | 98% | 8% |
| 1 | moderate | 75% | 60% | 39% |
| 1 | high | 61% | 38% | 54% |
| 1 | deadly | 12% | 5% | 92% |
| 2 | low | 91% | 82% | 26% |
| 2 | moderate | 70% | 47% | 54% |
| 2 | high | 36% | 18% | 79% |
| 2 | deadly | 13% | 4% | 93% |
| 3 | low | 87% | 72% | 33% |
| 3 | moderate | 70% | 43% | 56% |
| 3 | high | 30% | 9% | 84% |
| 3 | deadly | 8% | 0% | 97% |
| 4 | low | 96% | 89% | 21% |
| 4 | moderate | 55% | 34% | 66% |
| 4 | high | 30% | 9% | 85% |
| 4 | deadly | 10% | 1% | 96% |
| 5 | low | 95% | 85% | 26% |
| 5 | moderate | 62% | 41% | 61% |
| 5 | high | 39% | 22% | 77% |
| 5 | deadly | 9% | 1% | 96% |

### Policy-quality sensitivity (single fight win rate, same encounters)

| Level | Label | v0 (weapon only) | v1 (default quick build + features) | v2 (optimised spells, focus fire) |
| --- | --- | --- | --- | --- |
| 1 | low | 98% | 99% | 100% |
| 1 | moderate | 78% | 86% | 92% |
| 1 | high | 65% | 77% | 86% |
| 1 | deadly | 19% | 31% | 48% |
| 2 | low | 89% | 95% | 99% |
| 2 | moderate | 73% | 88% | 93% |
| 2 | high | 45% | 66% | 75% |
| 2 | deadly | 22% | 39% | 51% |
| 3 | low | 65% | 90% | 97% |
| 3 | moderate | 59% | 82% | 93% |
| 3 | high | 25% | 55% | 74% |
| 3 | deadly | 11% | 28% | 44% |
| 4 | low | 74% | 97% | 99% |
| 4 | moderate | 49% | 79% | 91% |
| 4 | high | 27% | 52% | 78% |
| 4 | deadly | 13% | 34% | 52% |
| 5 | low | 54% | 91% | 99% |
| 5 | moderate | 30% | 71% | 91% |
| 5 | high | 16% | 59% | 81% |
| 5 | deadly | 2% | 32% | 41% |

### Per-class spread: win rate at the shipped moderate encounter (v2, held-out)

| Class | L1 win | L2 win | L3 win | L4 win | L5 win | L1 HP/AC | L5 HP/AC | mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| barbarian | 100% | 100% | 100% | 100% | 99% | 15/14 | 55/14 | 100% |
| bard | 99% | 99% | 100% | 98% | 90% | 11/12 | 43/12 | 97% |
| cleric | 96% | 96% | 99% | 100% | 96% | 10/16 | 38/16 | 97% |
| druid | 95% | 93% | 94% | 96% | 89% | 10/14 | 38/14 | 93% |
| fighter | 98% | 100% | 100% | 99% | 97% | 12/16 | 44/16 | 99% |
| monk | 94% | 97% | 99% | 96% | 95% | 10/15 | 38/16 | 96% |
| paladin | 96% | 98% | 98% | 100% | 99% | 12/18 | 44/18 | 98% |
| ranger | 95% | 97% | 97% | 96% | 94% | 12/14 | 44/15 | 96% |
| rogue | 87% | 87% | 97% | 98% | 97% | 11/13 | 43/14 | 93% |
| sorcerer | 87% | 87% | 84% | 83% | 94% | 9/14 | 37/14 | 87% |
| warlock | 74% | 73% | 67% | 48% | 61% | 11/12 | 43/12 | 65% |
| wizard | 82% | 83% | 80% | 79% | 86% | 8/14 | 32/14 | 82% |

Weakest three: warlock 65%, wizard 82%, sorcerer 87%. Strongest three: barbarian 100%, fighter 99%, paladin 98%.

<!-- generated:end -->

## Policy sensitivity and limitations

* v2 does not model: subclass features, Cunning Action/Disengage, Wild Shape, Channel Divinity, Bardic Inspiration, Hex/Agonizing Blast, concentration spells (all excluded: no buffs, no control such as Sleep or Hold), reaction spells (Shield), consumables (potions), terrain/cover/kiting, hiding, mid-fight Hit Dice, or retreat. A skilled player has all of these, so true win rates are higher than v2's, probably by more than the v1→v2 gain (+5 to +26 points at the shipped moderate/high cells, mostly casters), which is the only quantified step.
* Foes are simplified too: no special abilities (e.g. grapple, poison, breath weapons), no fleeing or tactics, primary attack only. That makes them easier than the real catalog in some cases and the open field removes cover that would help the PC.
* Win means all foes defeated within 20 rounds with the PC not dead; a PC at 0 HP can still win (death saves are modelled), counted as a KO in the tables. An unattended 0 HP PC in play may be rescued or die, so KO is a separate risk signal.
* Class mean treats all 12 classes alike; the table is a population average, not a per-class one.
* Level 1–5 only, single PC, no allies, no hirelings or companions (animal companions are not modelled).
* Monster list is CR ≤ 5 from the loaded catalog; the shipped caps are 1–3 enemies except L4 moderate, which has no cap (its 75 XP budget buys about 3.2 weak enemies).

## Provenance and regeneration

* Table: `packages/engine/src/encounter/solo-difficulty.v1.json` (versioned, carries git sha of the commit the run started from, date, policy, both seed sets, grid, targets, `targetsApproved: true` (approved by the owner 2026-10-09)).
* Raw sweep (resumable JSONL, one line per finished class-cell): `packages/engine/calibration-data/solo-sweep.v1.jsonl`; verification: `solo-verify.v1.jsonl`; machine-readable results: `docs/plan/verification/solo-calibration-results.json`.
* Regenerate: `pnpm --filter @game/rules-engine calibrate:solo` (one niced worker, resumable: delete the two JSONL files for a clean rerun; about 25 minutes on a laptop). The tables above are rewritten from the data files by that script.
* Builder: `buildEncounter` defaults to `soloBudget: 'calibrated'` for a solo PC and reads the table by level and label; `soloBudget: 'srd'` gives the old 1× behaviour; `{ multiplier, maxEnemies }` is an explicit override. `deadly` is a new solo-only label.

## Decisions for the human

1. **What a single-fight label means.** Keep the single-fight HP band (unreachable for moderate/high here), or define the HP band on a 3-fight day with a short rest (reachable, per the sequence table), or drop the HP band and use win rate alone. Pending that, the table is fitted to win rate first.
2. **Approve or change the targets** above, especially moderate ≥ 90% win and deadly 35–60%.
3. **Which PC competence to calibrate for.** The table uses v2. If real players are better, labels run easier than named; v1 would make every label harder (the shipped moderate would then be about 70–88% win).
4. **Class imbalance:** accept a single population-average table, or add a per-class adjustment (the warlock case) or tell players which classes run hard solo.
5. **Warlock modelling** (Agonizing Blast, Hex) and subclass features if the warlock gap matters.
6. **Whether L1–L3 need an authored encounter list** instead of generated ones, since catalog monsters cannot separate moderate from high there.

## Approval (2026-10-09)

Approved by the owner as recommended: moderate and high are defined on win rate per fight plus an HP band measured over a 3-fight day with a short rest (the per-fight HP band in the table `targets` is informational only); win targets low ≥97%, moderate ≥90%, high ≥75%, deadly 35–60%; policy v2 stays the baseline; one population-average table for M2 with a "plays harder solo" note for warlock, wizard and sorcerer at character creation; per-class tuning in M3; warlock modelling is a backlog item; L1–L3 encounters in adventure #1 are hand-authored using the table for budget checks.
