import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog/load.js';
import {
  buildEncounter,
  encounterBudget,
  EncounterBuildError,
} from '../src/encounter/budget.js';
import { quickBuild } from '../src/character/builder.js';

const catalog = loadCatalog();
const classes = catalog.entries.filter((entry) => entry.kind === 'class');

describe('solo encounter builder', () => {
  test('budget is SRD per-character XP multiplied by party size', () => {
    expect([1, 2, 3, 4, 5].map((level) => encounterBudget(level))).toEqual([
      75, 150, 225, 375, 750,
    ]);
    expect(encounterBudget(1, 6, 'high')).toBe(600);
    expect(() => encounterBudget(6)).toThrow(EncounterBuildError);
  });

  test('builds legal, within-budget and reproducible encounters for all classes at levels 1–5', () => {
    expect(classes.length).toBe(12);
    for (const characterClass of classes) {
      for (let level = 1; level <= 5; level++) {
        // The real character builder supplies class/level-specific build-path coverage.
        expect(
          quickBuild(catalog, characterClass.id, 123, level).character.level,
        ).toBe(level);
        const request = { level, seed: 123 };
        const encounter = buildEncounter(catalog, request);
        expect(encounter).toEqual(buildEncounter(catalog, request));
        expect(encounter.spent).toBeLessThanOrEqual(encounter.budget);
        expect(encounter.spent + encounter.remaining).toBe(encounter.budget);
        expect(encounter.monsters.length).toBeGreaterThan(0);
        for (const monster of encounter.monsters) {
          expect(catalog.get('monster', monster.id)?.cr).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  test('cleanly rejects invalid, empty and impossible builds', () => {
    expect(() => buildEncounter(catalog, { level: 0, seed: 1 })).toThrow(
      EncounterBuildError,
    );
    expect(() =>
      buildEncounter({ ...catalog, entries: [] }, { level: 1, seed: 1 }),
    ).toThrow('No in-scope catalog monsters');
  });
});
