import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  AdventureSchema,
  NpcSchema,
  LocationSchema,
  QuestSchema,
  FlagSchema,
} from '@game/schema';
import adventure from '../adventures/01/adventure.json' with { type: 'json' };
import seed from '../adventures/01/registry-seed.json' with { type: 'json' };
import { loadCatalog } from '../src/catalog/load.js';
import { validateAdventure } from '../src/adventure/validate.js';
import { loadAuthoredMap } from '../src/map/load.js';
import { adventure01RegistrySeed } from '../src/adventure/registry-seed.js';
import { runAdventure01Encounter } from '../src/scripted/adventure01.js';

const catalog = loadCatalog();
const parsed = AdventureSchema.parse(adventure);

describe('Adventure #1', () => {
  test('all scenes, references, maps and spawns validate and are reachable', () => {
    expect(validateAdventure(parsed, catalog)).toMatchObject({ ok: true });
  });

  test('each structured dungeon map loads and renders as a valid map payload', () => {
    expect(parsed.maps).toHaveLength(3);
    for (const map of parsed.maps) {
      const disk = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../maps/${map.mapId}.json`, import.meta.url)),
          'utf8',
        ),
      ) as unknown;
      expect(loadAuthoredMap(disk)).toMatchObject({ ok: true });
      expect(map.w).toBeLessThanOrEqual(50);
      expect(map.h).toBeLessThanOrEqual(50);
    }
  });

  test.each(
    parsed.encounters.map((encounter) => [encounter.id, encounter.id] as const),
  )('scripted encounter %s ends in CombatEnded', (_label, encounterId) => {
    const run = runAdventure01Encounter(encounterId, 31031);
    expect(run.finalState.outcome).toBe('CombatEnded');
    expect(run.events.some((event) => event.type === 'CombatEnded')).toBe(true);
  });

  test('registry seed validates and includes the canon facts, quest and starting flags', () => {
    for (const npc of seed.npcs)
      expect(NpcSchema.safeParse(npc).success).toBe(true);
    for (const location of seed.locations)
      expect(LocationSchema.safeParse(location).success).toBe(true);
    for (const quest of seed.quests)
      expect(QuestSchema.safeParse(quest).success).toBe(true);
    for (const flag of seed.flags)
      expect(FlagSchema.safeParse(flag).success).toBe(true);
    const diffs = adventure01RegistrySeed();
    expect(diffs).toHaveLength(10);
    expect(
      diffs.find((diff) => diff.id === 'quest_bitter_well')?.after,
    ).toMatchObject({ status: 'available' });
    expect(
      diffs.find((diff) => diff.id === 'flag_well_bitter')?.after,
    ).toMatchObject({ value: true });
  });
});
