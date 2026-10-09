# Adventure #1 fact sheet: do not contradict

DM-facing, one page. Seeds the registry in M2-31. Anything here is canon; nothing in play may contradict it. Unlisted details are free to improvise if they do not clash.

## Setting

- Marrowfell: hill village, one stone well, about 120 residents. (`loc-marrowfell`)
- Gallows Knoll: the hill above it; a sinkhole opened there nine days before the story starts. (`loc-gallows-knoll`)
- Tallow Hold: buried keep of an extinct order of lamp-keepers. Three levels: Upper Ruins (gatehouse, Chapel of Wicks), Cinderwick Warrens, Lamp Vault. (`loc-tallow-hold`)
- The Ember Lamp: kept alive by the lamp-keepers; it binds the dead of the hold and keeps the spring sweet. It is guttering now. (`loc-ember-lamp`)
- The well water turned bitter nine days ago; the well-head lamps cannot be relit. (`flag-well-bitter`)

## Hard facts

1. The Chapel of Wicks door opens by lighting the six wicks from low to high. (`flag-chapel-order`)
2. The goblin clan is the Cinderwick clan. Its boss is Skarrik Cinderwick, who wears a stolen breastplate and keeps the Cinderwick key on a cord around his neck.
3. The Tallow Larder is protected by an old ward; goblins will not enter it.
4. The winch shaft is a one-way trip down. The chain is greased and the lift is broken after use. After the lamp choice a rear stair opens to the knoll.
5. The warden of the vault is a bound dead Specter. They are not evil; they guard the lamp.
6. The lamp can be relit (well runs clean in three days, wardens settle) or smothered (wardens fight, the dead are freed, the well never recovers).
7. No healing is available at Marrowfell beyond what the PC carries.
8. No magic items exist in this adventure other than the Spell Scroll (Level 1) and Potion of Healing in the loot table.

## NPCs

| Registry id | Name | Role | Disposition | Facts they know |
| --- | --- | --- | --- | --- |
| `npc-nessa-kell` | Nessa Kell | Well-warden of Marrowfell, quest giver | friendly | Well went bitter nine days ago; knoll opened beneath a ram; Tallow Hold built by lamp-keepers; lamp keeps "something quiet" below; pays 20 gp now, 60 gp on return |
| `npc-tobren-vask` | Tobren Vask | Surveyor trapped in the chapel alcove | friendly (once freed) | Wicks lit low to high; the Level 2 layout; the shaft chain is greased though unused for a century; the boss wears a stolen breastplate |
| `npc-pip-ashgrub` | Pip Ashgrub | Goblin deserter hiding in the larder | neutral | Skarrik keeps the key on a cord at his neck; goblins fear the larder; the boss hall has a back door; "the smoke people" grease the chain each dusk |

## Quests and flags

| Id | Meaning |
| --- | --- |
| `quest-bitter-well` | Restore the well. Available at start, active on accept, completed or failed per the lamp choice |
| `flag-pip-spared` / `flag-pip-slain` | Fate of Pip |
| `flag-boss-truce` | PC bargained with Skarrik |
| `flag-lamp-relit` / `flag-lamp-smothered` | The choice at scene 8 |

## Names (all original)

Marrowfell, Gallows Knoll, Tallow Hold, Chapel of Wicks, Tallow Larder, Cinderwick (clan), Skarrik Cinderwick, Ember Lamp, Nessa Kell, Tobren Vask, Pip Ashgrub.

## Monsters and numbers

Catalog monsters only: Giant Fire Beetle, Goblin Warrior, Goblin Minion, Goblin Boss, Specter; NPC stat blocks: Commoner, Goblin Minion. Encounters: E1 (1 Giant Fire Beetle), E2 (1 Goblin Warrior), E3 (1 Goblin Boss, party at level 3), E4 (1 Specter). Never add or swap monsters without a ruling logged by `log_ruling`.
