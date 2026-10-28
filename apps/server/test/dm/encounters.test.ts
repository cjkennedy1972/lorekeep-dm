import { describe, expect, it } from 'vitest';
import { AdventureSchema } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { loadAdventure } from '@game/rules-engine/adventure-node';
import adventureData from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import {
  EncounterStartRejectionBudget,
  encounterKeysForTurn,
  offeredEncounters,
  redactedEncounterId,
  resolveEncounter,
  toEngineMonsterId,
} from '../../src/dm/encounters.js';

const adventure = AdventureSchema.parse(adventureData);
const catalog = loadCatalog();
const lookouts = 'encounter-e2-lookouts';
const sceneId = 'scene-warren-gallery';

describe('authored encounter resolution (ADR-038)', () => {
  it('resolves a declared key to the authored roster in the engine id format', () => {
    expect(resolveEncounter(adventure, sceneId, lookouts, new Set())).toEqual({
      ok: true,
      enemies: [
        {
          monsterId: 'srd:monster/goblin-lookout',
          count: 1,
          spawnRef: 'mk_e2_enemy',
        },
      ],
      ambushSide: 'none',
      mapId: 'adv01-warrens',
      partySpawnRef: 'mk_e2_party',
    });
  });
  it('allows encounters without a party marker so bootstrap can use the spawn zone', () => {
    const withoutPartyMarker = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) => {
        if (encounter.id !== lookouts) return encounter;
        const withoutMarker = { ...encounter };
        delete withoutMarker.partySpawnMarkerId;
        return withoutMarker;
      }),
    };
    expect(loadAdventure(withoutPartyMarker, catalog).ok).toBe(true);
    expect(
      resolveEncounter(withoutPartyMarker, sceneId, lookouts, new Set()),
    ).toMatchObject({ ok: true, mapId: 'adv01-warrens' });
    expect(
      resolveEncounter(withoutPartyMarker, sceneId, lookouts, new Set()),
    ).not.toHaveProperty('partySpawnRef');
  });
  it('rejects unknown, other-scene and already-used keys with closed codes', () => {
    expect(resolveEncounter(adventure, sceneId, 'missing', new Set())).toEqual({
      ok: false,
      code: 'unknown-encounter',
    });
    expect(
      resolveEncounter(adventure, 'scene-boss-hall', lookouts, new Set()),
    ).toEqual({ ok: false, code: 'encounter-not-in-scene' });
    expect(
      resolveEncounter(adventure, 'no-such-scene', lookouts, new Set()),
    ).toEqual({ ok: false, code: 'encounter-not-in-scene' });
    expect(
      resolveEncounter(adventure, sceneId, lookouts, new Set([lookouts])),
    ).toEqual({ ok: false, code: 'ENCOUNTER_ALREADY_USED' });
  });
  it('rejects an unresolvable party marker instead of allowing combat to start', () => {
    const invalidPartyMarker = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) =>
        encounter.id === lookouts
          ? { ...encounter, partySpawnMarkerId: 'missing-party-marker' }
          : encounter,
      ),
    };
    expect(
      resolveEncounter(invalidPartyMarker, sceneId, lookouts, new Set()),
    ).toEqual({
      ok: false,
      code: 'encounter-roster-invalid',
    });
  });
  it('rejects an encounter that is active and invalid authored roster/map data', () => {
    expect(
      resolveEncounter(
        adventure,
        sceneId,
        lookouts,
        new Set(),
        new Set([lookouts]),
      ),
    ).toEqual({ ok: false, code: 'ENCOUNTER_ALREADY_USED' });
    const invalidRoster = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) =>
        encounter.id === lookouts
          ? { ...encounter, monsterIds: ['goblin-warrior'] }
          : encounter,
      ),
    };
    expect(
      resolveEncounter(invalidRoster, sceneId, lookouts, new Set()),
    ).toEqual({ ok: false, code: 'encounter-roster-invalid' });
    const invalidMap = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) =>
        encounter.id === lookouts
          ? { ...encounter, mapId: 'missing-map' }
          : encounter,
      ),
    };
    expect(resolveEncounter(invalidMap, sceneId, lookouts, new Set())).toEqual({
      ok: false,
      code: 'encounter-roster-invalid',
    });
    const invalidMarker = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) =>
        encounter.id === lookouts
          ? { ...encounter, enemySpawnMarkerId: 'missing-marker' }
          : encounter,
      ),
    };
    expect(
      resolveEncounter(invalidMarker, sceneId, lookouts, new Set()),
    ).toEqual({ ok: false, code: 'encounter-roster-invalid' });
  });
  it('allows only authored repeatable encounters to restart after resolution', () => {
    const repeatable = {
      ...adventure,
      encounters: adventure.encounters.map((encounter) =>
        encounter.id === lookouts
          ? { ...encounter, repeatable: true }
          : encounter,
      ),
    };
    expect(
      resolveEncounter(repeatable, sceneId, lookouts, new Set([lookouts])).ok,
    ).toBe(true);
    expect(
      resolveEncounter(adventure, sceneId, lookouts, new Set([lookouts])),
    ).toEqual({ ok: false, code: 'ENCOUNTER_ALREADY_USED' });
    expect(
      offeredEncounters(repeatable, sceneId, new Set([lookouts])),
    ).toContain(lookouts);
  });
  it("offers only the current scene's unresolved encounters", () => {
    expect(offeredEncounters(adventure, sceneId, new Set())).toEqual([
      lookouts,
    ]);
    expect(offeredEncounters(adventure, sceneId, new Set([lookouts]))).toEqual(
      [],
    );
    expect(
      offeredEncounters(adventure, sceneId, new Set(), new Set([lookouts])),
    ).toEqual([]);
    expect(
      offeredEncounters(adventure, 'scene-marowfell-well', new Set()),
    ).toEqual([]);
  });
  it('every authored encounter monster converts to an id the engine catalog resolves', () => {
    for (const encounter of adventure.encounters)
      for (const authored of encounter.monsterIds) {
        const engineId = toEngineMonsterId(authored);
        expect(engineId).toMatch(/^srd:monster\/[a-z0-9-]+$/);
        expect(
          catalog.get(
            'monster',
            engineId.replace(/^srd:monster\//, 'monster:'),
          ),
        ).toBeDefined();
      }
  });
});

describe('ADR-038 rollout flag', () => {
  it('is disabled unless explicitly set to true', async () => {
    const { storyCombatFlagEnabled } = await import(
      '../../src/room/productionTurnRunner.js'
    );
    expect(storyCombatFlagEnabled(undefined)).toBe(false);
    expect(storyCombatFlagEnabled('false')).toBe(false);
    expect(storyCombatFlagEnabled('true')).toBe(true);
  });
});

describe('combat-start rejection accounting', () => {
  it('keeps six rejected starts in the rolling window and withdraws on the seventh only for that session and scene', () => {
    const budget = new EncounterStartRejectionBudget();
    for (let index = 1; index <= 6; index++)
      expect(
        budget.record(
          'session-a',
          sceneId,
          `turn-${index}`,
          `reason-${index}`,
          index * 100,
        ).withdrawn,
      ).toBe(false);
    expect(
      budget.record('session-a', sceneId, 'turn-overflow', 'overflow', 700)
        .withdrawn,
    ).toBe(true);
    expect(budget.isWithdrawn('session-a', sceneId, 700)).toBe(true);
    expect(budget.isWithdrawn('session-a', sceneId, 30_700)).toBe(true);
    expect(budget.isWithdrawn('session-a', sceneId, 61_700)).toBe(true);
    expect(budget.isWithdrawn('session-b', sceneId, 700)).toBe(false);
    expect(budget.isWithdrawn('session-a', 'scene-other', 700)).toBe(false);
  });

  it('counts one rejection per turn and distinct reason, and expires old rejections', () => {
    const budget = new EncounterStartRejectionBudget();
    for (let index = 0; index < 6; index++)
      budget.record(
        'session-a',
        sceneId,
        `turn-${index}`,
        `reason-${index}`,
        index * 10,
      );
    expect(
      budget.record('session-a', sceneId, 'turn-new', 'reason-new', 60_100),
    ).toMatchObject({
      count: 1,
      withdrawn: false,
    });
    const deduped = new EncounterStartRejectionBudget();
    expect(
      deduped.record('session-a', sceneId, 'same-turn', 'same-reason', 60_110)
        .count,
    ).toBe(1);
    expect(
      deduped.record('session-a', sceneId, 'same-turn', 'same-reason', 60_120)
        .count,
    ).toBe(1);
    expect(
      deduped.record('session-a', sceneId, 'same-turn', 'other-reason', 60_130)
        .count,
    ).toBe(2);
    expect(redactedEncounterId('encounter-e2-lookouts')).toEqual({
      encounterId: 'encounter-e2-lookouts',
    });
    expect(redactedEncounterId('unsafe key with text')).toMatchObject({
      encounterIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});

describe('encounter tool withdrawal', () => {
  it('clears a session budget on scene change and session end, and bounds old entries', () => {
    const budget = new EncounterStartRejectionBudget(0, 60_000, 2, 100);
    budget.enterScene('session-a', sceneId, 1);
    budget.record('session-a', sceneId, 'turn-1', 'reason', 2);
    expect(budget.isWithdrawn('session-a', sceneId, 3)).toBe(true);
    budget.enterScene('session-a', 'scene-next', 4);
    expect(budget.isWithdrawn('session-a', sceneId, 5)).toBe(false);
    budget.record('session-a', 'scene-next', 'turn-2', 'reason', 6);
    budget.clearSession('session-a');
    expect(budget.isWithdrawn('session-a', 'scene-next', 7)).toBe(false);
    const boundedBudget = new EncounterStartRejectionBudget(6, 60_000, 2, 100);
    boundedBudget.record('s1', 'a', 't', 'r', 10);
    boundedBudget.record('s2', 'b', 't', 'r', 11);
    boundedBudget.record('s3', 'c', 't', 'r', 12);
    expect(boundedBudget.isWithdrawn('s1', 'a', 13)).toBe(false);
    expect(boundedBudget.isWithdrawn('s3', 'c', 13)).toBe(false);
    boundedBudget.record('s3', 'c', 't2', 'r', 200);
    expect(boundedBudget.isWithdrawn('s3', 'c', 301)).toBe(false);
  });

  it('keeps withdrawals independent of bounded counters and caps withdrawals by oldest-first eviction', () => {
    const budget = new EncounterStartRejectionBudget(6, 60_000, 1, 100, 2);
    for (const [sessionId, base] of [
      ['oldest', 1],
      ['middle', 20],
      ['newest-before-fresh', 30],
    ] as const)
      for (let index = 1; index <= 7; index++)
        budget.record(
          sessionId,
          'scene',
          `turn-${index}`,
          `reason-${index}`,
          base + index,
        );

    // A full withdrawal store cannot evict fresh counters before the threshold.
    for (let index = 1; index <= 7; index++) {
      const result = budget.record(
        'fresh',
        'scene',
        `turn-${index}`,
        `reason-${index}`,
        40 + index,
      );
      expect(result.count).toBe(index);
      expect(result.withdrawn).toBe(index === 7);
    }
    expect(budget.isWithdrawn('fresh', 'scene', 50)).toBe(true);
    expect(budget.isWithdrawn('oldest', 'scene', 50)).toBe(false);
    expect(budget.isWithdrawn('middle', 'scene', 50)).toBe(false);
    expect(budget.isWithdrawn('newest-before-fresh', 'scene', 50)).toBe(true);
  });

  it('keeps withdrawn scenes through age and size pruning until lifecycle clear', () => {
    const budget = new EncounterStartRejectionBudget(1, 60_000, 1, 100);
    budget.enterScene('session-a', 'scene-a', 1);
    budget.record('session-a', 'scene-a', 'turn-1', 'reason-1', 2);
    budget.record('session-a', 'scene-a', 'turn-2', 'reason-2', 3);
    expect(budget.isWithdrawn('session-a', 'scene-a', 3)).toBe(true);

    // A non-withdrawn entry creates cache pressure but cannot evict withdrawal.
    budget.record('session-b', 'scene-b', 'turn-1', 'reason', 4);
    expect(budget.isWithdrawn('session-a', 'scene-a', 4)).toBe(true);
    expect(budget.isWithdrawn('session-a', 'scene-a', 2 + 61 * 60_000)).toBe(
      true,
    );
    expect(
      budget.isWithdrawn('session-a', 'scene-a', 2 + 2 * 60 * 60_000),
    ).toBe(true);

    // Age pruning must not discard scene tracking needed to observe this change.
    budget.enterScene('session-a', 'scene-next', 2 + 2 * 60 * 60_000 + 1);
    expect(
      budget.isWithdrawn('session-a', 'scene-a', 2 + 2 * 60 * 60_000 + 2),
    ).toBe(false);
    budget.record(
      'session-a',
      'scene-next',
      'turn-2',
      'reason-1',
      2 + 2 * 60 * 60_000 + 3,
    );
    budget.record(
      'session-a',
      'scene-next',
      'turn-3',
      'reason-2',
      2 + 2 * 60 * 60_000 + 4,
    );
    expect(
      budget.isWithdrawn('session-a', 'scene-next', 2 + 2 * 60 * 60_000 + 4),
    ).toBe(true);
    budget.clearSession('session-a');
    expect(
      budget.isWithdrawn('session-a', 'scene-next', 2 + 2 * 60 * 60_000 + 5),
    ).toBe(false);
  });

  it('removes start_combat affordances once the rejection budget is withdrawn for a scene', () => {
    const budget = new EncounterStartRejectionBudget();
    const eligible = offeredEncounters(adventure, sceneId, new Set());
    expect(encounterKeysForTurn(true, eligible, false)).toEqual([lookouts]);
    for (let index = 0; index < 6; index++)
      budget.record(
        'session-a',
        sceneId,
        `turn-${index}`,
        `reason-${index}`,
        index * 100,
      );
    const overflow = budget.record(
      'session-a',
      sceneId,
      'turn-overflow',
      'overflow',
      700,
    );
    expect(encounterKeysForTurn(true, eligible, overflow.withdrawn)).toEqual(
      [],
    );
    expect(encounterKeysForTurn(false, eligible, false)).toEqual([]);
  });
});
