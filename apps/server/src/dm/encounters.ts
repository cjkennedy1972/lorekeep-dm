import type { Adventure } from '@game/schema';

/** Closed rejection codes for the model-facing start_combat (ADR-038). */
export type EncounterErrorCode =
  | 'ENCOUNTER_ALREADY_USED'
  | 'unknown-encounter'
  | 'encounter-not-in-scene';

export interface ResolvedEnemy {
  monsterId: string;
  count: number;
  spawnRef: string;
}

/**
 * Authored adventure ids ('monster:goblin-warrior') use the catalog namespace; the engine's
 * start_combat input uses 'srd:monster/<slug>' and converts it back (tools/combat.ts). Adventure
 * load already validates every encounter monster against the catalog (engine adventure/validate.ts),
 * so no mapping table is needed, only this prefix rule.
 */
export const toEngineMonsterId = (authoredId: string): string =>
  authoredId.replace(/^monster:/, 'srd:monster/');

/** Resolves a model-supplied encounter key against server data; never trusts model rosters. */
export function resolveEncounter(
  adventure: Adventure,
  sceneId: string,
  encounterKey: string,
  resolvedSet: ReadonlySet<string>,
):
  | { ok: true; enemies: ResolvedEnemy[]; ambushSide: 'none'; mapId: string }
  | { ok: false; code: EncounterErrorCode } {
  const encounter = adventure.encounters.find(({ id }) => id === encounterKey);
  if (!encounter) return { ok: false, code: 'unknown-encounter' };
  if (resolvedSet.has(encounterKey))
    return { ok: false, code: 'ENCOUNTER_ALREADY_USED' };
  const scene = adventure.scenes.find(({ id }) => id === sceneId);
  if (!scene?.encounterIds.includes(encounterKey))
    return { ok: false, code: 'encounter-not-in-scene' };
  // Authored rosters list one creature per entry (ponytail: no authored counts yet).
  return {
    ok: true,
    enemies: encounter.monsterIds.map((authoredId) => ({
      monsterId: toEngineMonsterId(authoredId),
      count: 1,
      spawnRef: encounter.enemySpawnMarkerId,
    })),
    ambushSide: 'none',
    mapId: encounter.mapId,
  };
}

/** Encounters a scene declares and the session has not resolved: what the model may be offered. */
export function offeredEncounters(
  adventure: Adventure,
  sceneId: string,
  resolvedSet: ReadonlySet<string>,
): string[] {
  const scene = adventure.scenes.find(({ id }) => id === sceneId);
  return (scene?.encounterIds ?? []).filter((id) => !resolvedSet.has(id));
}
