import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';

// Expected counts come from the SRD 5.2.1 spell descriptions (339 spells in
// total; 27 cantrips + 57 L1 + 57 L2 + 42 L3 = 183 within scope).
const expected = JSON.parse(
  readFileSync(
    new URL('./catalog-v0-expected-counts.json', import.meta.url),
    'utf8',
  ),
).spell;
const cat = loadCatalog();
const spells = cat.entries.flatMap((e) => (e.kind === 'spell' ? [e] : []));
const byName = (name: string) => spells.find((s) => s.name === name);

describe('catalog spells level 0-3', () => {
  test('spell count matches the expected-counts file', () => {
    expect(spells).toHaveLength(expected.total);
    for (const [lvl, n] of Object.entries<number>(expected.byLevel))
      expect(spells.filter((s) => s.level === Number(lvl))).toHaveLength(n);
    expect(spells.every((s) => s.level <= 3)).toBe(true);
  });
  test('every spell cites an SRD page and has full mechanics fields', () => {
    for (const s of spells) {
      expect(s.srd.ref, s.id).toMatch(
        /^Spells > Spell Descriptions > .+ \(p\. \d+\)$/,
      );
      expect(s.classes.length, s.id).toBeGreaterThan(0);
      for (const f of [
        s.castingTime,
        s.range,
        s.components,
        s.duration,
        s.resolution,
      ])
        expect(f, s.id).toBeDefined();
      expect(typeof s.ritual, s.id).toBe('boolean');
      expect(typeof s.concentration, s.id).toBe('boolean');
    }
  });
  test('concentration flag agrees with a concentration duration', () => {
    for (const s of spells)
      if (s.concentration) {
        expect(s.duration?.kind, s.id).toBe('timed');
        if (s.duration?.kind === 'timed') expect(s.duration.upTo).toBe(true);
      }
  });
  test('every damaging spell has dice and damage type', () => {
    const damaging = spells.filter((s) => s.damage);
    expect(damaging.length).toBeGreaterThan(40);
    for (const s of damaging)
      for (const d of s.damage ?? []) {
        expect(d.dice, s.id).toMatch(/^\d+d\d+(\+\d+)?$/);
        expect(d.types.length, s.id).toBeGreaterThan(0);
      }
  });
  test('every save spell names ability and onSuccess', () => {
    const saves = spells.filter((s) => s.resolution?.kind === 'save');
    expect(saves.length).toBeGreaterThan(30);
    for (const s of saves)
      if (s.resolution?.kind === 'save') {
        expect(s.resolution.ability, s.id).toMatch(
          /^(str|dex|con|int|wis|cha)$/,
        );
        expect(['none', 'half', 'partial']).toContain(s.resolution.onSuccess);
      }
  });
  test('half-damage saves deal damage; attack spells deal damage', () => {
    for (const s of spells) {
      if (s.resolution?.kind === 'save' && s.resolution.onSuccess === 'half')
        expect(s.damage, s.id).toBeDefined();
      if (s.resolution?.kind === 'attack' && s.id !== 'spell:true-strike')
        expect(s.damage, s.id).toBeDefined();
    }
  });
  test('each area spell has a template with shape and size in feet', () => {
    const shapes = new Set<string>();
    for (const s of spells)
      if (s.template) {
        shapes.add(s.template.shape);
        expect(s.template.size, s.id).toBeGreaterThan(0);
      }
    for (const sh of ['sphere', 'cube', 'cone', 'line', 'cylinder'])
      expect(shapes.has(sh), sh).toBe(true);
    // Emanation and square are SRD 5.2.1 shapes beyond the ticket's five.
    expect([...shapes].sort()).toEqual([
      'cone',
      'cube',
      'cylinder',
      'emanation',
      'line',
      'sphere',
      'square',
    ]);
  });
  test('damaging save spells with a named area have a template', () => {
    for (const id of [
      'fireball',
      'burning-hands',
      'thunderwave',
      'lightning-bolt',
      'shatter',
      'moonbeam',
    ])
      expect(
        spells.find((s) => s.id === `spell:${id}`)?.template,
        id,
      ).toBeDefined();
  });
  test('Fireball, Burning Hands and a cube spell load with SRD values', () => {
    const fb = byName('Fireball');
    expect(fb?.level).toBe(3);
    expect(fb?.range).toEqual({ kind: 'feet', feet: 150 });
    expect(fb?.template).toEqual({ shape: 'sphere', size: 20 });
    expect(fb?.resolution).toEqual({
      kind: 'save',
      ability: 'dex',
      onSuccess: 'half',
    });
    expect(fb?.damage).toEqual([
      {
        dice: '8d6',
        types: ['fire'],
        scaling: { slot: { dice: '1d6' } },
      },
    ]);
    const bh = byName('Burning Hands');
    expect(bh?.template).toEqual({ shape: 'cone', size: 15 });
    expect(bh?.damage?.[0]?.dice).toBe('3d6');
    expect(byName('Thunderwave')?.template).toEqual({
      shape: 'cube',
      size: 15,
    });
    expect(byName('Faerie Fire')?.template).toEqual({
      shape: 'cube',
      size: 20,
    });
  });
  test('cantrips scale and healing spells carry dice', () => {
    expect(byName('Fire Bolt')?.damage?.[0]?.scaling?.cantrip?.dice).toEqual([
      '2d10',
      '3d10',
      '4d10',
    ]);
    expect(
      byName('Eldritch Blast')?.damage?.[0]?.scaling?.cantrip?.count,
    ).toEqual([2, 3, 4]);
    expect(byName('Cure Wounds')?.healing).toEqual({
      dice: '2d8',
      addsModifier: true,
      slotDice: '2d8',
    });
    expect(byName('Magic Missile')?.damage?.[0]).toMatchObject({
      dice: '1d4+1',
      count: 3,
    });
  });
  test('ritual, reaction and concentration spot checks', () => {
    expect(byName('Alarm')?.ritual).toBe(true);
    expect(byName('Alarm')?.castingTime).toEqual({ unit: 'minute', amount: 1 });
    expect(byName('Shield')?.castingTime?.unit).toBe('reaction');
    expect(byName('Bless')?.concentration).toBe(true);
    expect(byName('Fireball')?.concentration).toBe(false);
  });
});
