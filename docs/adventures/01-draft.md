# Adventure #1: The Hollow Under Marrowfell

Status: draft for M2-31 encoding. Owner: quill. Theme (human decision): a classic, multi-level dungeon crawl.

## At a glance

| | |
| --- | --- |
| Party | One level-1 PC (party-ready; see "Party notes") |
| Length | 2-3 hours, 8 scenes, 4 encounters |
| Levels | 3 dungeon levels, each its own 2D battlemap, linked by named transitions |
| Target growth | Level 1 at the start, level 3-4 at the end (see "Advancement", an open question) |
| Rests | One planned short rest (scene 5). One point of no return (scene 7) |
| Tone | Lamplit and creeping: old stone, wet cold, small mercies. Danger is real, never grim for its own sake. Mature content stays at the table default (implied, not explicit). |

## Premise

Marrowfell is a hill village that drinks from one stone well. Nine days ago the water turned bitter and the lamps that burn at the well-head went out and would not relight. A shepherd's ram fell through a sinkhole on Gallows Knoll and the village now knows what the old stories hinted at: the knoll is the roof of a buried keep, the Tallow Hold, where an extinct order of lamp-keepers once kept a single Ember Lamp alive to bind the dead below and sweeten the spring.

The lamp is guttering. A goblin clan, the Cinderwick, moved into the middle level when the ceiling broke, and their cook-fires foul the water further. The player is a stranger with a sword or a spell and a lamp-lit reason to go down. Nessa Kell, the well-warden, will pay what the village has.

## Structure

```
 [1 Marrowfell] -- hub, quest start
        |
   (sinkhole / gate stair)
        v
 LEVEL 1  Upper Ruins     [2 Broken Gatehouse] -> [3 Chapel of Wicks]
        |  transition: "chapel-stair" (stairs, one-way until opened)
        v
 LEVEL 2  Cinderwick Warrens  [4 Warren Gallery] -> [5 Tallow Larder] -> [6 Boss Hall]
        |  transition: "winch-shaft" (chain lift; POINT OF NO RETURN)
        v
 LEVEL 3  Lamp Vault      [7 Winch Shaft landing] -> [8 The Lamp Vault]
```

Scene 7 is a short skill-challenge scene that is the point of no return (chain fouls, lift is lost). It uses the Level 3 map (landing area) for its setting and no encounter.

## Scenes

Read-aloud text is two to four sentences; the DM paraphrases freely and never adds new facts that contradict `01-fact-sheet.md`.

### Scene 1: Marrowfell Well (village hub, no map)

Read aloud: "The well-head is ringed with dead lamps, their wicks black. Nessa Kell holds a bucket of water the colour of weak tea. 'It tastes of ash, and the children are sick. Gallows Knoll opened up nine days back. Go down and find out why.'"

- NPC: Nessa Kell (see NPCs). Quest hook `quest-bitter-well`: restore the well.
- Offer: 20 gp now, 60 gp on return, a healing potion (`equipment:potion-of-healing`) if the lamp is relit.
- Gear shop is out of scope; the PC may be granted `equipment:torch` x3 and `equipment:rope` once.
- Exits to scene 2 (the gate stair on the knoll).

### Scene 2: The Broken Gatehouse (Level 1, upper ruins)

Read aloud: "A leaning gate tower spills rubble across a flagged yard. Beyond the arch, cold air smells of tallow and wet rat."

- Terrain: courtyard of rubble, pillars as cover, one closed door to the chapel hall.
- Trap (T1, tripwire alarm): see Traps. Noticing it saves the PC from rousing the beetle.
- Encounter E1 (easy): a giant fire beetle, its glands glowing, nesting in the gatehouse kennel.
- Loot: see Loot Table, "upper".

### Scene 3: The Chapel of Wicks (Level 1)

Read aloud: "Six iron sconces line a vaulted chapel, each holding a wick-stub. On the far wall, a stone door has six cup-shaped hollows and no handle."

- Puzzle (P1, the six wicks): see Puzzles.
- NPC: Tobren Vask, a surveyor trapped by a rockfall in a side alcove. Freeing him (DC 12 Strength check, or 10 minutes clearing rubble with `equipment:crowbar`) earns his map of Level 2.
- Transition `chapel-stair`: the opened door reveals a spiral stair down to Level 2.
- Milestone: the PC reaches level 2 on completing scenes 2 and 3 (see Advancement).

### Scene 4: The Warren Gallery (Level 2, Cinderwick warrens)

Read aloud: "The stair opens into a long gallery of cut-and-patched stone, hung with rags and drying bones. Somewhere ahead a goblin is humming off-key."

- Chokepoint: a narrow neck (1 cell wide) halfway down the gallery. Enemies bunch behind it.
- Encounter E2 (moderate): a lone goblin lookout (one Goblin Warrior) at the neck.
- Trap (T2, snare line) just past the neck.
- Exits: east to the larder (scene 5), south to the boss hall (scene 6, a locked double door until the PC has the Cinderwick key or breaks it).

### Scene 5: The Tallow Larder (Level 2, safe room)

Read aloud: "A dry cellar of shelves and barrels, sealed on one side by a heavy plank door. Someone has swept it clean."

- The planned short rest. The room is defensible: one door (DC 10 to bar, `equipment:lock` optional), no random encounters here (the DM may inject one only if the table's rest-interruption chance fires; default is no).
- NPC: Pip Ashgrub, a goblin deserter hiding in the barrels. Hostile only if attacked; friendly if shown mercy (Insight DC 11 shows he is afraid, not dangerous).
- Loot: see Loot Table, "larder".
- Sets the flag `flag-pip-spared` or `flag-pip-slain`.
- Milestone: the PC reaches level 3 here, after the short rest, before the boss hall (see Advancement).

### Scene 6: The Boss Hall (Level 2 map, level 3 party)

Read aloud: "A pillared feasting hall, long tables dragged into a barricade. At the head, a goblin in a stolen breastplate picks his teeth with a knife and sizes you up."

- Encounter E3 (hard, tuned for a level 3 party): Skarrik Cinderwick alone (his minions have fled or fallen). Parley option: Persuasion or Intimidation DC 14 gets a truce (the boss lets the PC pass to the shaft and demands the Cinderwick key back from Tobren's corpse or his own cache); this ends the encounter with `end_combat` outcome `truce` and costs the PC the loot in his cache.
- Pip's information (if spared) gives advantage on the first attack against the boss and reveals the hall's back door (a second approach, cover from pillars).
- Exit: the winch shaft (scene 7).

### Scene 7: The Winch Shaft (Level 3 landing, POINT OF NO RETURN)

Read aloud: "A black shaft with a chain lift and a hand-crank winch. Below, a faint amber light. The chain is greased and new; someone has used this recently."

- Warn the player: going down is permanent; the chain will not carry anyone back. The DM must say this in plain words before the descent (see DM notes).
- Skill challenge (see Puzzles, P2): get down safely. Each failure costs a resource, never an outcome the player did not see coming.
- On a safe landing the PC arrives on the Level 3 map at the landing marker. If the PC falls, they take falling damage as resolved by the engine, if an engine path exists (open question 3).
- Transition `winch-shaft` is one-way. A later ascent is possible only by the vault's rear stair after the finale (see scene 8), which re-opens when the lamp's choice is made.

### Scene 8: The Lamp Vault (Level 3, deep vault)

Read aloud: "A round vault of grey stone. In its centre, on a pedestal, the Ember Lamp gutters, its flame no taller than a thumbnail. Shapes of smoke drift and watch."

- Encounter E4 (hard): the lamp-warden, a single bound Specter, wakes when the lamp is touched.
- THE CHOICE (see below): relight the lamp, or smother it and take the vault's hoard.
- The rear stair rises to the knoll sinkhole, closing the loop to scene 1.

## Encounters

Difficulty intent is easy, moderate or hard (maps to the M2-32 builder's low, moderate, high). The XP budget share is the proposed fraction of the whole adventure's combat XP (see "Advancement"). This draft does not apply a solo multiplier; the calibration ticket sets it and M2-31 applies it. Monster names match the catalog exactly.

| ID | Scene | Level / map | Monsters (catalog name) | Intent | Raw XP | Budget share |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 2 | 1 Upper Ruins | 1 x Giant Fire Beetle | easy | 10 | 2% |
| E2 | 4 | 2 Warrens | 1 x Goblin Warrior | moderate | 50 | 11% |
| E3 | 6 | 2 Warrens (level 3 party) | 1 x Goblin Boss | hard | 200 | 43% |
| E4 | 8 | 3 Lamp Vault | 1 x Specter | hard | 200 | 43% |

Raw XP uses the catalog CR to XP table in `packages/engine/src/encounter/budget.ts` (CR 1/8 = 25, 1/4 = 50, 1/2 = 100, CR 1 = 200). Total raw combat XP is 460 (rosters were thinned and re-tuned in the difficulty verification, `docs/plan/verification/adventure01-difficulty.md`; budget shares are the share of this total, rounded).

Tactics (the engine's `move_to` modes carry the positions; the DM never states grid coordinates):

- E1: the beetle charges the nearest PC and flees at half HP. Easy test for the first combat.
- E2: the goblin lookout holds the neck. If the PC fights in the gallery's open half they get cover from pillars (`move_to` mode `cover`).
- E3: the boss stays behind the table barricade (three-quarters cover) for the first round, then charges. Pip's tip or a lit-oil trick (Scene 6 hazard) turns the fight.
- E4: the specter drifts out of the wall on round two. Relighting the lamp before the fight ends the encounter with `end_combat` `truce`; see the choice.

## Traps and puzzles (all resolved by engine checks)

The DM proposes a check, the engine rolls it. The model never decides an outcome. Each entry gives the DC, the engine tool, what success and failure change.

### Traps

| ID | Where | Detect | Disarm or avoid | On failure | Tool |
| --- | --- | --- | --- | --- | --- |
| T1 Tripwire alarm | Scene 2, yard arch | Perception DC 12 (passive 12 notices) | Dexterity (thieves' tools, `equipment:thieves-tools`) DC 12, or step over | Cans of bone clatter; E1 starts with the rats ambushing (`start_combat` `ambushSide: enemies`) | `request_check` (ability `wis`, skill `perception`; then `dex`) |
| T2 Snare line | Scene 4, past the chokepoint | Investigation DC 13 | Dexterity DC 13 to step over, or Strength DC 10 to cut it | Dexterity save DC 12 or restrained until the PC spends an action to free themselves | `request_check`, `request_save`, `apply_condition` (restrained, `until-removed`) |
| T3 Bitter-lamp fumes | Scene 6, spilled lamp oil hazard | Survival DC 12 | Light the oil from range (any fire source) or skirt the spill | Constitution save DC 12 or poisoned for 1 minute | `request_save`, `apply_condition` (poisoned, `1-minute`) |

### Puzzles

| ID | Where | Challenge | Resolution | Tool |
| --- | --- | --- | --- | --- |
| P1 Six wicks | Scene 3 | Six cups on the door, six wick-stubs in the sconces. A fresco of the order shows the lighting order: "dark to bright, low to high". | Intelligence (History) DC 12 or Wisdom (Religion) DC 12 to read the fresco; success tells the order, failure leaves the PC to test it (each wrong cup costs one torch or tinderbox use, never HP). Two successes in total open the door. A forced door: Strength DC 18, noisy. | `request_check` x2 |
| P2 Winch shaft | Scene 7 | Descend a black shaft on a greased chain lift | Three checks, any two successes lower the lift softly: Strength (Athletics) DC 12 to brake the crank, Dexterity (Acrobatics) DC 12 to step aboard, Intelligence or Wisdom (Perception) DC 12 to spot the fouled link. Zero or one success: the chain snaps and the PC takes falling damage as the engine resolves it (open question 3). | `request_check` x3 |
| P3 The lamp ritual | Scene 8 | Relighting the Ember Lamp without waking the warden | Intelligence (Arcana) or Wisdom (Religion) DC 14 with `equipment:oil` and `equipment:tinderbox`; success relights quietly (no E4). Failure wakes the wardens. | `request_check`, `consume_item`, `end_combat` (`truce`) |

## NPCs

Each NPC has a registry seed (see `01-fact-sheet.md`). Stat block: use the catalog creature named in brackets if a fight happens.

### Nessa Kell, well-warden of Marrowfell [Commoner]

Motive: save the village's children and keep her post. Practical, tired, honest. Pays on return, never before the lamp is dealt with. Facts she knows: the well went bitter nine days ago; the knoll opened beneath a ram; the Tallow Hold is old and was built by lamp-keepers; her grandmother said the lamp keeps "something quiet" below.

### Tobren Vask, trapped surveyor [Commoner]

Motive: get out alive and be paid for his map. Nervous, wordy, brave when cornered. Facts he knows: the chapel door opens by lighting the wicks low to high; the Level 2 layout (he mapped the goblin warrens before the rockfall); the winch shaft leads to the vault and the chain "has not been used in a hundred years, yet it is greased"; the goblins' boss wears a stolen breastplate.

### Pip Ashgrub, goblin deserter [Goblin Minion]

Motive: get away from a boss who starves his own clan. Skittish, bargaining, loyal to anyone who feeds him. Facts he knows: Skarrik, the boss, keeps the Cinderwick key on a cord around his neck; the larder is the only room the goblins fear (an old ward turns them back); the back door of the boss hall; the shaft chain was greased by "the smoke people" every dusk.

## Loot table (catalog equipment only)

Rewards are `grant_item` calls (`srd:item/<slug>`), coins as `srd:currency/gp`. The DM draws only from this table. Items marked once are granted one time.

| Location | Item (catalog name) | Qty | Note |
| --- | --- | --- | --- |
| Upper (E1, yard) | Dagger | 1 | Rusted but sound |
| Upper (chapel alcove) | Torch | 3 | Once |
| Upper (chapel) | Healer's Kit | 1 | Tobren's, if freed |
| Larder | Rations | 4 | Once |
| Larder | Potion of Healing | 1 | Pip's hidden stash |
| Larder | Rope | 1 | Hempen, 50 ft |
| Warrens (E2 loot) | Handaxe | 2 | |
| Warrens (E2 loot) | Light Crossbow | 1 | With Bolts x10 |
| Boss hall (E3) | Breastplate | 1 | Skarrik's; usable only if the PC proficiency allows |
| Boss hall (E3) | Shield | 1 | |
| Boss hall (cache) | Alchemist's Fire | 2 | Lost on a truce |
| Vault | Holy Water | 2 | Always, one if the warden is slain, both if the lamp is relit |
| Vault (smother choice) | Spell Scroll (Level 1) | 1 | The hoard |
| Vault (smother choice) | Crystal | 1 | The hoard |
| Coins | gp | 20-60 | Per scene, DM draws 1d4 x 10 if no table row applies |

## The choice (scene 8): the Ember Lamp

The lamp binds the dead of the Tallow Hold and sweetens the spring. The PC must choose, in character, and the choice must be visible to the player before they commit.

- **Relight the lamp** (P3 ritual; DC 14; costs `equipment:oil` x1). The warden settles and fades, the well runs clean in three days, the village is grateful. The PC gets Nessa's full payment, the potion of healing, and the Holy Water. No hoard.
- **Smother the lamp** and take the hoard (Spell Scroll Level 1, Crystal, and Holy Water). The bound dead are freed and the warden fights (E4). The well never recovers. The village is poorer and Nessa pays half.

Consequences are recorded by `set_flag` (`flag-lamp-relit` or `flag-lamp-smothered`) and `update_quest`, so a later adventure can reference them. A truce (`end_combat` `truce`) is the intended outcome of relighting.

## Map briefs (for M2-31)

All maps are 2D top-down grids, cell = 5 ft, cap 50 x 50 (schema allows 60 x 60). Terrain palette ids available: `floor`, `rubble`, `pillar`, `stone-wall`, `grass`, `tree`, `water`, `mud`. Doors are edges (`closed`, `locked`, `open`). Features carry `cover` and `difficult-terrain`; markers name spawns (`kind: spawn` zones are markers here). Each encounter gets one party spawn marker and one enemy spawn marker.

Legend: W = stone-wall, . = floor, R = rubble (move cost 2), P = pillar (full cover), ~ = water, m = mud, g = grass, t = tree.

### Map `adv01-upper-ruins` (Level 1, 32 x 28)

Purpose: scenes 2-3, encounter E1.

- Outer yard (rows 0-13): grass edge on the north, central flagged floor, rubble drifts (R) near the broken tower in the east, 4 pillars as cover, 2 `tree` cells at the north-west corner.
- Gatehouse arch at (15,13): a 1-cell-wide chokepoint with a `door` edge (`open`). T1 tripwire sits in the arch.
- Chapel hall (rows 15-26): 14 x 10 vaulted room, 6 sconces on the north wall (features, no terrain cost), side alcove at (3-4, 22-23) for Tobren (rubble block).
- Hazard: rubble band in the yard (difficult terrain); no water. Elevation 0 throughout.
- Doors: arch to chapel (closed, then the six-wick door `locked` at (29,21)).
- Markers: `mk_e1_party` (15,11), `mk_e1_enemy` (15,5), `mk_stair_down` (30,21).
- Reachability: party spawn must reach every enemy spawn on open floor; keep >= 2 cells between walls everywhere except the arch.

### Map `adv01-warrens` (Level 2, 44 x 36)

Purpose: scenes 4-6, encounters E2 and E3.

- Gallery (rows 2-10): a 36-cell-long east-west hall, 5 cells wide. The 1-cell neck at x=18 is the chokepoint. Rubble ramps at the east end, 3 pillars on the west half for cover.
- Larder (rows 12-18, x 4-14): 11 x 7 room, one door edge `closed` (plank door), barrels as features (half cover). No water, no mud.
- Boss hall (rows 20-33, x 12-40): 28 x 14 pillared hall, 8 pillars in two rows, barricade feature across the head (three-quarters cover, row 22). A `mud` patch and a `water` cistern corner to the south-west (the spilled-oil hazard T3 is a feature `hazard`).
- Locked double door (2 `door` edges, `locked`) between gallery and hall at (22,11).
- Winch shaft alcove at the hall's south wall (x 20-22, y 33), a 3-cell `floor` strip behind a door (`closed`).
- Markers: `mk_e2_party` (3,5), `mk_e2_enemy` (24,5), `mk_e3_party` (22,18), `mk_e3_enemy` (26,24), `mk_stair_up` (2,4), `mk_shaft` (21,32).
- Reachability: both enemy spawns must be reachable from their party spawn without passing through the locked double door; E3's party spawn lies on the larder side.

### Map `adv01-lamp-vault` (Level 3, 30 x 30)

Purpose: scenes 7-8, encounter E4.

- Landing (rows 1-6): 8 x 6 floor area, chain-lift column feature at the north wall, `rubble` where the lift fell if P2 failed.
- Corridor (rows 7-12): 3-wide, leads south to a double doors (open).
- Vault (rows 13-28): circular-ish room radius 7 (use a diamond/octagon of floor in a wall-filled field), central pedestal (1 cell, feature `pedestal`), 6 `pillar` cells in a ring (cover), 4 deep alcoves (unlit, dim light zones) at the compass points where the shadows start.
- Hazard: unlit cells are dim light (stealth for the specter); no water. Optional `water` cells at the east edge for a dripping basin (visual only).
- Rear stair at (15,28), a `door` edge (`locked` until the lamp choice is made).
- Markers: `mk_landing` (4,3), `mk_e4_party` (15,14), `mk_e4_enemy_ring` (15,22), `mk_stair_up` (15,27).
- Reachability: from `mk_e4_party` every alcove and the pedestal must be reachable.

## Advancement

After the difficulty re-tune the four encounters total 460 raw XP (see Encounters). Level 2 needs 300 XP, level 3 needs 900, level 4 needs 2700, so combat XP alone no longer carries the PC past level 2 and the milestones below are the only source of levels 2-4. Proposed milestone awards (additive to combat XP, resolved by the DM through `update_quest`):

| Milestone | Reward |
| --- | --- |
| Complete scenes 2-3 (E1, P1, Tobren freed) | Level 2 |
| Complete scenes 4-5 (E2, Pip resolved, short rest in the larder), before the boss hall | Level 3 |
| Resolve scene 8 (E4 or ritual) | Level 4, or high level 3 if the table prefers slower growth |

Open question: pick milestone leveling for adventure #1 or add XP awards for traps, puzzles and the choice. This draft assumes milestones until the calibration ticket decides.

## Party notes

For 2-4 PCs: add one Goblin Warrior to E2, one Skeleton to E4, and keep the traps unchanged. These notes use catalog names only; the M2-32 builder owns real scaling.

## DM guidance notes

- Never name a grid cell. Use `move_to` and the map's marker labels ("the north door", "the neck of the gallery").
- Every number comes from the engine. Do not narrate a hit, a damage figure or a save outcome before the tool result.
- At scene 7, say plainly: "Going down is a one-way trip." Wait for the player to agree before running P2.
- Short rest: invite it in scene 5 (end of the first goblin fight is the natural point). Do not force it.
- Failure is forward: a failed check costs a torch, a hit die, a tool use or a position, and always leaves a path.
- Keep read-aloud short. After it, ask what the PC does.
- Do not contradict `01-fact-sheet.md`. If a rule or fact is missing, call `rules_lookup` or `log_ruling` rather than inventing.

## Content checks

- All names are original (Marrowfell, Tallow Hold, Cinderwick, Ember Lamp, Gallows Knoll, Nessa Kell, Tobren Vask, Pip Ashgrub, Skarrik Cinderwick). No non-SRD proprietary names (checked against the M2-29 denylist).
- Monsters used: Giant Fire Beetle, Goblin Warrior, Goblin Minion, Goblin Boss, Specter (all CR 0-1, in the catalog). Commoner is used as an NPC stat block.
- Items: only catalog equipment (see the loot table).
