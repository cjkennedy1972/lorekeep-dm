import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog/load.js';
import {
  buildEncounter,
  encounterBudget,
  soloCalibration,
  type EncounterDifficulty,
} from '../src/encounter/budget.js';
import table from '../src/encounter/solo-difficulty.v1.json' with { type: 'json' };
import { readRows } from '../src/calibration/pool.js';
import { fitTable, LABELS, TARGETS } from '../src/calibration/select.js';
import { aggregate, runCell, type CellSpec } from '../src/calibration/sweep.js';
import { CLASS_SLUGS } from '../src/calibration/pc.js';

const catalog = loadCatalog();
const levels = [1, 2, 3, 4, 5];
const sweepFile = new URL(
  '../calibration-data/solo-sweep.v1.jsonl',
  import.meta.url,
);

describe('solo calibration table', () => {
  test('has provenance and covers every level and label', () => {
    expect(table.version).toBe(1);
    expect(table.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(table.calibrationSeed).not.toBe(table.heldoutSeed);
    for (const level of levels)
      for (const label of LABELS)
        expect(soloCalibration(level, label).multiplier).toBeGreaterThan(0);
  });

  test('the builder default is the calibrated table; srd keeps the old 1x behaviour', () => {
    for (const level of levels)
      for (const label of LABELS) {
        const cell = soloCalibration(level, label);
        const base = { level, seed: 7, difficulty: label };
        const cal = buildEncounter(catalog, base);
        expect(cal.model).toBe('calibrated');
        expect(cal.multiplier).toBe(cell.multiplier);
        expect(cal.maxEnemies).toBe(cell.maxEnemies);
        if (label === 'deadly') continue; // no SRD row to compare against
        const srd = buildEncounter(catalog, { ...base, soloBudget: 'srd' });
        expect(srd.model).toBe('srd');
        expect(srd.budget).toBe(encounterBudget(level, 1, label));
      }
  });

  test('is deterministic and every encounter stays inside its declared budget and cap', () => {
    for (const level of levels)
      for (const label of LABELS)
        for (let seed = 1; seed <= 25; seed++) {
          const request = { level, seed, difficulty: label };
          const enc = buildEncounter(catalog, request);
          expect(enc).toEqual(buildEncounter(catalog, request));
          const cell = soloCalibration(level, label);
          expect(enc.budget).toBe(
            Math.floor(enc.srdBudget * cell.multiplier + 1e-9),
          );
          expect(enc.spent).toBeLessThanOrEqual(enc.budget);
          expect(enc.monsters.length).toBeGreaterThan(0);
          if (cell.maxEnemies)
            expect(enc.monsters.length).toBeLessThanOrEqual(cell.maxEnemies);
        }
  });

  test('absolute budgets rise with the label at each level', () => {
    for (const level of levels) {
      const budget = (l: EncounterDifficulty) =>
        Math.floor(
          encounterBudget(level, 1, l) * soloCalibration(level, l).multiplier +
            1e-9,
        );
      expect(budget('low')).toBeLessThanOrEqual(budget('moderate'));
      expect(budget('moderate')).toBeLessThanOrEqual(budget('high'));
      expect(budget('high')).toBeLessThanOrEqual(budget('deadly'));
    }
  });

  test('fitting the committed sweep reproduces the committed table', () => {
    const fitted = fitTable(readRows(sweepFile.pathname));
    expect(JSON.parse(JSON.stringify(fitted))).toEqual(table.levels);
  });

  test('regeneration is reproducible: the same cell and seeds give identical counts', () => {
    const spec: CellSpec = {
      policy: 'v2',
      level: 2,
      classSlug: 'fighter',
      k: 0.5,
      maxEnemies: 2,
      seeds: 5,
      seedBase: 99,
      mode: 'single',
    };
    expect(runCell(catalog, spec)).toEqual(runCell(catalog, spec));
  });

  // A small, fresh-seed re-simulation of the shipped path (label + table multiplier) lands each
  // label near its fitted win rate. 12 classes x 8 seeds per cell, so the tolerance is wide on purpose.
  test('quick re-simulation reproduces each label within tolerance', () => {
    for (const level of levels)
      for (const label of LABELS) {
        const cell = soloCalibration(level, label);
        const rows = CLASS_SLUGS.map((classSlug) =>
          runCell(catalog, {
            policy: 'v2',
            level,
            classSlug,
            k: cell.multiplier,
            maxEnemies: cell.maxEnemies ?? null,
            label,
            seeds: 8,
            seedBase: 424242,
            mode: 'single',
          }),
        );
        const agg = aggregate(rows);
        const fit = (
          table.levels as Record<
            string,
            Record<string, { fit: { win: number } }>
          >
        )[String(level)]![label]!.fit.win;
        expect(Math.abs(agg.win - fit), `${level}/${label}`).toBeLessThan(0.2);
        const band = TARGETS[label];
        // the label keeps its character: deadly stays a coin-flip, low stays near-safe
        if (label === 'deadly') expect(agg.win).toBeLessThan(0.75);
        if (label === 'low') expect(agg.win).toBeGreaterThan(band.winMin - 0.15);
      }
  }, 60_000);

  test('table file is valid JSON on disk', () => {
    expect(() =>
      JSON.parse(
        readFileSync(
          new URL('../src/encounter/solo-difficulty.v1.json', import.meta.url),
          'utf8',
        ),
      ),
    ).not.toThrow();
  });
});
