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
  const map = adventure.maps.find(
    (candidate) => candidate.mapId === encounter.mapId,
  );
  if (
    !encounter.monsterIds.length ||
    encounter.monsterIds.some((id) => !/^monster:[a-z0-9-]+$/u.test(id)) ||
    !map ||
    !map.markers.some(
      (marker) => marker.markerId === encounter.enemySpawnMarkerId,
    )
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
  private readonly entries = new Map<
    string,
    {
      rejectedAt: number[];
      withdrawn: boolean;
      touchedAt: number;
      turns: Map<string, Set<string>>;
    }
  >();
  private readonly activeSceneBySession = new Map<
    string,
    { sceneId: string; touchedAt: number }
  >();

  constructor(
    private readonly limit = 6,
    private readonly windowMs = 60_000,
    private readonly maxEntries = 2_000,
    private readonly maxAgeMs = 60 * 60_000,
  ) {}

  enterScene(
    sessionId: string,
    sceneId: string | undefined,
    now = Date.now(),
  ): void {
    this.prune(now);
    const previous = this.activeSceneBySession.get(sessionId)?.sceneId;
    if (previous !== undefined && previous !== sceneId)
      this.clearSession(sessionId);
    if (sceneId === undefined) this.activeSceneBySession.delete(sessionId);
    else this.activeSceneBySession.set(sessionId, { sceneId, touchedAt: now });
    while (this.activeSceneBySession.size > this.maxEntries) {
      const oldest = this.activeSceneBySession.keys().next().value;
      if (oldest === undefined) break;
      this.activeSceneBySession.delete(oldest);
    }
  }

  isWithdrawn(sessionId: string, sceneId: string, now = Date.now()): boolean {
    this.prune(now);
    return this.entries.get(this.key(sessionId, sceneId))?.withdrawn ?? false;
  }

  // ADR-029 §8 shared Mutations bucket is a deliberate follow-up; this remains a separate in-process budget for now.
  record(
    sessionId: string,
    sceneId: string,
    turnId: string,
    reason: string,
    now = Date.now(),
  ): { count: number; withdrawn: boolean } {
    this.prune(now);
    const key = this.key(sessionId, sceneId);
    const entry = this.entries.get(key) ?? {
      rejectedAt: [],
      withdrawn: false,
      touchedAt: now,
      turns: new Map<string, Set<string>>(),
    };
    entry.rejectedAt = entry.rejectedAt.filter(
      (at) => now - at < this.windowMs,
    );
    const reasons = entry.turns.get(turnId) ?? new Set<string>();
    if (!reasons.has(reason)) {
      reasons.add(reason);
      entry.rejectedAt.push(now);
      if (entry.rejectedAt.length > this.limit + 1)
        entry.rejectedAt.splice(0, entry.rejectedAt.length - this.limit - 1);
    }
    entry.turns.set(turnId, reasons);
    entry.withdrawn ||= entry.rejectedAt.length > this.limit;
    entry.touchedAt = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.prune(now);
    return { count: entry.rejectedAt.length, withdrawn: entry.withdrawn };
  }

  clearSession(sessionId: string): void {
    this.activeSceneBySession.delete(sessionId);
    for (const key of this.entries.keys())
      if (key.startsWith(`${sessionId}:`)) this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [sessionId, active] of this.activeSceneBySession)
      if (now - active.touchedAt > this.maxAgeMs)
        this.activeSceneBySession.delete(sessionId);
    for (const [key, entry] of this.entries) {
      entry.rejectedAt = entry.rejectedAt.filter(
        (at) => now - at < this.windowMs,
      );
      if (now - entry.touchedAt > this.maxAgeMs) this.entries.delete(key);
      else if (entry.turns.size > 256) {
        for (const turnId of [...entry.turns.keys()].slice(
          0,
          entry.turns.size - 256,
        ))
          entry.turns.delete(turnId);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private key(sessionId: string, sceneId: string): string {
    return `${sessionId}:${sceneId}`;
  }
}

export const encounterStartRejectionBudget =
  new EncounterStartRejectionBudget();

/** Prompt affordance after rollout and scene-scoped rejection-budget policy. */
export function encounterKeysForTurn(
  enabled: boolean,
  eligible: readonly string[],
  withdrawn: boolean,
): string[] {
  return enabled && !withdrawn ? [...eligible] : [];
}
