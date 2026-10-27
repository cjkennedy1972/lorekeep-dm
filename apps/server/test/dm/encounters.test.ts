import { describe, expect, it } from 'vitest';
import { AdventureSchema } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import adventureData from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import {
  offeredEncounters,
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
          monsterId: 'srd:monster/goblin-warrior',
          count: 1,
          spawnRef: 'mk_e2_enemy',
        },
      ],
      ambushSide: 'none',
      mapId: 'adv01-warrens',
    });
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
