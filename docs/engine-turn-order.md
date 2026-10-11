# Turn order and action economy: enforcement status (M3-21)

Status key: **blocked** = rejected before resolution today; **missing** = allowed today; **n/a** = not modeled.

| Case | Path | Status | Notes |
| --- | --- | --- | --- |
| Player attack when not active | Room command (`combat.ts` execute) | blocked | `NOT_YOUR_TURN` gate runs before command branches. |
| Player cast when not active | Room command (`combat.ts`) | blocked | Same gate. |
| Player move when not active | Room command (`combat.ts`) | blocked | Same gate. |
| DM `attack` naming a non-active attacker | DM tool (`tools/attack.ts`) | blocked (this change) | Executor checks `turnActorId`, returns `not-actors-turn`. |
| DM `cast_spell` naming a non-active caster | DM tool (`tools/spell.ts`) | blocked (this change) | Same as above. |
| DM `move_to` naming a non-active entity | DM tool (`tools/movement.ts`) | blocked (this change) | Reads `turnActorId` only. The old fallback to `gameEngine.combat.activeEntityId` was removed: `start_combat` never sets it, so it was dead. |
| Second action in one turn (DM path) | DM tool / room `resources.action` | missing | DM-path action spend is not persisted to `combatRoom`. Not added in M3-21. |
| Bonus action | any | n/a | Not modeled in the engine. |
| Reaction when not active (US-B2) | `combatEngine.ts` `answerReaction` | allowed (by design) | Gated to the prompt's `entityId`/`moverId`. Unchanged. |
| Out-of-character chat when not active | chat path | allowed (by design) | Not gated. Verified by reading only, no new test. |

## Rule for the DM tool path

`productionTurnRunner` passes the live combatant as `turnActorId` to the tool executor. It is derived from `combatRoom` (`ended` gives null; otherwise `combat.activeEntityId`, falling back to the first initiative entry). It is not persisted. When `turnActorId` is null, the guard does not apply. Out-of-combat calls are therefore unaffected.

`not-actors-turn` is a recoverable rejection. The orchestrator does not count it against the retry budget or the tool-call cap (the call never executed). The hint names the active combatant. The DM prompt carries the same live combatant as a `TURN ORDER` line, so the model normally names only that combatant.

## Known gaps

- Second action on the DM path is not enforced.
- Bonus actions are not modeled.
- The DM-path guard depends on `combatRoom` being wired into the executor input.
- TODO: summoned or companion entities that are absent from `combat.initiative` are rejected with `not-actors-turn` every time, so they can never act. No summon code exists yet. When summons land, add them to initiative or exempt them from the guard.
