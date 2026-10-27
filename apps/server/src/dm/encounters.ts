import { createHash } from 'node:crypto';
import type { Adventure } from '@game/schema';

/** Closed rejection codes for the model-facing start_combat (ADR-038). */
export type EncounterErrorCode =
  | 'ENCOUNTER_ALREADY_USED'
  | 'unknown-encounter'
  | 'encounter-not-in-scene'
  | 'encounter-roster-invalid';

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
  activeEncounterIds: ReadonlySet<string> = new Set(),
):
  | { ok: true; enemies: ResolvedEnemy[]; ambushSide: 'none'; mapId: string }
  | { ok: false; code: EncounterErrorCode } {
  const encounter = adventure.encounters.find(({ id }) => id === encounterKey);
  if (!encounter) return { ok: false, code: 'unknown-encounter' };
  if (
    activeEncounterIds.has(encounterKey) ||
    (resolvedSet.has(encounterKey) && !encounter.repeatable)
  )
    return { ok: false, code: 'ENCOUNTER_ALREADY_USED' };
  const scene = adventure.scenes.find(({ id }) => id === sceneId);
  if (!scene?.encounterIds.includes(encounterKey))
    return { ok: false, code: 'encounter-not-in-scene' };
  // Fail closed if unvalidated adventure data reaches a live turn. Adventure load is
  // responsible for catalog validation; this guards the server-to-engine contract.
  if (
    !encounter.monsterIds.length ||
    encounter.monsterIds.some((id) => !/^monster:[a-z0-9-]+$/u.test(id)) ||
    !adventure.maps.some((map) => map.mapId === encounter.mapId)
  )
    return { ok: false, code: 'encounter-roster-invalid' };
  // Authored rosters list one creature per entry (there is no authored count field).
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
  activeEncounterIds: ReadonlySet<string> = new Set(),
): string[] {
  const scene = adventure.scenes.find(({ id }) => id === sceneId);
  return (scene?.encounterIds ?? []).filter((id) => {
    const encounter = adventure.encounters.find(
      (candidate) => candidate.id === id,
    );
    return (
      !!encounter &&
      !activeEncounterIds.has(id) &&
      (encounter.repeatable || !resolvedSet.has(id))
    );
  });
}

const SAFE_ENCOUNTER_ID = /^[a-z0-9:_-]{1,64}$/u;
export function redactedEncounterId(
  value: string,
): { encounterId: string } | { encounterIdHash: string } {
  return SAFE_ENCOUNTER_ID.test(value)
    ? { encounterId: value }
    : { encounterIdHash: createHash('sha256').update(value).digest('hex') };
}

/** In-process rolling mutation budget; rejection counters are not game-state mutations. */
export class EncounterStartRejectionBudget {
  private readonly rejectedAt = new Map<string, number[]>();
  private readonly withdrawn = new Set<string>();

  constructor(
    private readonly limit = 6,
    private readonly windowMs = 60_000,
  ) {}

  isWithdrawn(sessionId: string, accountId: string, sceneId: string): boolean {
    return this.withdrawn.has(this.key(sessionId, accountId, sceneId));
  }

  record(
    sessionId: string,
    accountId: string,
    sceneId: string,
    now = Date.now(),
  ): { count: number; withdrawn: boolean } {
    const key = this.key(sessionId, accountId, sceneId);
    const recent = (this.rejectedAt.get(key) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    recent.push(now);
    this.rejectedAt.set(key, recent);
    if (recent.length > this.limit) this.withdrawn.add(key);
    return { count: recent.length, withdrawn: this.withdrawn.has(key) };
  }

  private key(sessionId: string, accountId: string, sceneId: string): string {
    return `${sessionId}:${accountId}:${sceneId}`;
  }
}
