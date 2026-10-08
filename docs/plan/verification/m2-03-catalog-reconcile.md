# M2-03: catalog reconciliation against SRD 5.2.1

Closes the M1 gap "catalog counts not reconciled" (m1-proof-report.md, section on monster and spell coverage). No catalog data was edited; this report feeds M2-04.

## Source and method

- Source: official SRD 5.2.1 PDF (CC-BY-4.0, Wizards of the Coast), `https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf`, 364 pages, sha256 `8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87`.
- `scripts/srd-extract.py` (PyMuPDF) turns the PDF into `docs/plan/verification/srd-5.2.1-index.json`: names plus parsed stats, each with the SRD page. It is a one-off; the index is committed so the diff needs no PDF.
- `scripts/catalog-reconcile.mjs` diffs the index against `packages/engine/catalog/*.json` by normalised name (case, punctuation, apostrophes ignored) and then field by field. `--report` writes the machine-readable `docs/plan/verification/m2-03-catalog-diff.json`. It exits 1 while any SRD entry is missing from the catalog.
- `packages/engine/test/catalog-reconcile.test.ts` reads the real catalog. The "no missing entries" check is a `test.fails`, so it passes now and turns red when M2-04 closes the gap (then change it to a plain `test`). Another test proves the diff is not vacuous by deleting a spell, changing a monster's HP and renaming a weapon in a temp copy.
- Parsing is regex over PDF text, so parser mistakes are possible; every mismatch below was checked against the SRD text by hand or the parser was fixed first.

## Counts (missing / extra / name-mismatched / stat-mismatched)

| Kind | SRD | Catalog | Missing | Extra | Name mismatch | Stat mismatch |
|---|---|---|---|---|---|---|
| monster (CR 0-5) | 242 | 242 | 0 | 0 | 0 | 14 |
| spell (level 0-3) | 183 | 183 | 0 | 0 | 0 | 1 |
| class | 12 | 12 | 0 | 0 | 0 | 0 (0 level 1-5 feature gaps) |
| subclass | 12 | 12 | 0 | 0 | 0 | not compared |
| species | 9 | 9 | 0 | 0 | 0 | 0 |
| background | 4 | 4 | 0 | 0 | 0 | 0 |
| condition | 15 | 15 | 0 | 0 | 0 | not compared |
| equipment: weapon | 38 | 36 | 2 | 0 | 0 | 0 |
| equipment: armor | 13 | 13 | 0 | 0 | 0 | 0 |
| equipment: gear and tools | 115 | 16 | 102 | 3 | 2 | 0 |
| **Total** | | | **104** | **3** | **2** | **15** |

The monster and spell lists match the SRD by name, one to one.

## Missing, extra, name-mismatched

- Weapons missing (2): Musket, Pistol (SRD Martial Ranged, p.91).
- Gear and tools missing (102): everything in the SRD Adventuring Gear table, Ammunition table and Tools section that the catalog does not carry, e.g. Acid, Alchemist's Fire, the Artisan's Tools, packs, Bolts, Bullets. Full list in the JSON (`kinds["equipment:gear-and-tools"].missing`). M2-04 should decide which of these the game needs; the catalog only ever aimed at starting kits, so this count is expected to be large.
- Extra (3), catalog entries with no SRD counterpart: `Crossbow Bolts` (SRD calls it "Bolts", p.96), `Lute` (not in the SRD at all; the SRD only has "Musical Instrument (Varies)"), `Spellbook` (appears only in class text, not in a gear table).
- Name mismatch (2): "Healers Kit" vs SRD "Healer's Kit"; "Thieves Tools" vs SRD "Thieves' Tools".

## Stat mismatches (all 15, each cited)

| Kind | Entry | Field | SRD | Catalog | Cite |
|---|---|---|---|---|---|
| monster | Barbed Devil | passivePerception | 18 | null | SRD 5.2.1 p.262, Monsters A-Z > Barbed Devil |
| monster | Bearded Devil | passivePerception | 10 | null | SRD 5.2.1 p.262, Monsters A-Z > Bearded Devil |
| monster | Giant Scorpion | attack:Claw.damage | 1d6+3 bludgeoning | 1 bludgeoning | SRD 5.2.1 p.353, Animals > Giant Scorpion |
| monster | Gibbering Mouther | attack:Bite.damage | 2d6 piercing | 1 bludgeoning | SRD 5.2.1 p.288, Monsters A-Z > Gibbering Mouther |
| monster | Griffon | attack:Rend.damage | 1d8+4 piercing | 1 bludgeoning | SRD 5.2.1 p.295, Monsters A-Z > Griffon |
| monster | Swarm of Bats | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.361, Animals > Swarm of Bats |
| monster | Swarm of Crawling Claws | creatureType | swarm of tiny undead | undead | SRD 5.2.1 p.278, Monsters A-Z > Swarm of Crawling Claws |
| monster | Swarm of Insects | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.361, Animals > Swarm of Insects |
| monster | Swarm of Piranhas | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.362, Animals > Swarm of Piranhas |
| monster | Swarm of Rats | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.362, Animals > Swarm of Rats |
| monster | Swarm of Ravens | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.362, Animals > Swarm of Ravens |
| monster | Swarm of Venomous Snakes | creatureType | swarm of tiny beasts | swarm | SRD 5.2.1 p.362, Animals > Swarm of Venomous Snakes |
| monster | Vampire Spawn | attack:Claw.damage | 2d4+3 slashing | 1 bludgeoning | SRD 5.2.1 p.334, Monsters A-Z > Vampire Spawn |
| monster | Winter Wolf | attack:Bite.damage | 2d6+4 piercing | 1 bludgeoning | SRD 5.2.1 p.342, Monsters A-Z > Winter Wolf |
| spell | Meld into Stone | damage | ["6d6","force"] | absent | SRD 5.2.1 p.148, Spells > Spell Descriptions > Meld into Stone |

Reading the monster rows:
- Five attack rows (Giant Scorpion, Gibbering Mouther, Griffon, Vampire Spawn, Winter Wolf) have placeholder damage `1 bludgeoning` in `damage`; the real SRD dice sit only in the free-text `effect` field, so the engine cannot roll them. Highest-value fix for M2-04.
- Two devils lack `passivePerception`.
- Seven swarms use `creatureType` "swarm" (or "undead"); the SRD type is "Swarm of Tiny Beasts/Undead" and the catalog schema has no swarm structure, so this is a modelling decision for M2-04 rather than a typo.
- Meld into Stone: the 6d6 Force damage is a conditional clause (stone destroyed); low severity.

## What was reconciled how

Fully reconciled (every SRD entry compared, not sampled) on the fields listed:

- Names: all ten kinds above, plus subclasses and conditions (names only).
- Monsters, all 242 (so the 10% stratified-by-CR sample is exceeded: 29 CR 0, 19 CR 1/8, 32 CR 1/4, 27 CR 1/2, 27 CR 1, 42 CR 2, 25 CR 3, 16 CR 4, 25 CR 5 are all compared): size, creature type, CR, AC, initiative, HP, HP dice, walk speed, six ability scores, passive Perception, and the to-hit bonus plus first damage dice and type of every attack the parser could read (213 of 242 SRD stat blocks yielded at least one attack).
- Spells, all 183 (exceeds 25): level, school, class list, casting time (unit, amount, ritual), range, V/S/M components and material text, duration (kind, amount, unit, up to), concentration, first damage dice and type.
- Classes, all 12 (level 1-5 tables): hit die, primary ability, saving throws, and the feature names at each level 1-5 against the SRD "Features" table. The "<Class> Subclass" row is ignored on both sides.
- Species (size, speed), backgrounds (skills, ability options), weapons/armor/gear cost and weight where the SRD gives one.

Not compared at all (unverified; the catalog may still differ from the SRD here):

- Monster traits and action text, multiattack, saves, skills, senses other than passive Perception, languages, resistances/immunities, vulnerabilities, legendary actions, attacks the regex could not read (flat-damage "1 Piercing" attacks and attacks with save-based effects), non-walk speeds.
- Spell description text, area/template, save ability and effect on success, scaling dice, targets.
- Class proficiencies, skill lists, starting equipment, feature descriptions, spell slot tables, subclass features, species traits, condition descriptions.
- Weapon damage/properties/mastery and armor AC/strength/stealth (the catalog does not carry them).

Equipment rows are not "by sample"; weapons and armor are complete by name, cost and weight, gear and tools by name only for what is missing and by cost/weight for the 13 matched entries.

## Re-run

```
node scripts/catalog-reconcile.mjs --report   # exits 1 until M2-04 lands the 104 missing entries
python3 scripts/srd-extract.py SRD_CC_v5.2.1.pdf docs/plan/verification/srd-5.2.1-index.json   # only to rebuild the index (needs pymupdf)
```

Attribution: This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
