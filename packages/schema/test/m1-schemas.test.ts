import { describe, expect, test } from 'vitest';
import {
  CatalogEntrySchema,
  CharacterSchema,
  CombatStateSchema,
  EngineEventSchema,
  type EngineEvent,
} from '../src/index.js';

const srd = { source: 'SRD 5.2.1', ref: 'p.1' };
const b = { catalogVersion: '1', srd, name: 'X' };
const uuid = '123e4567-e89b-42d3-a456-426614174000';

const catalogValid = [
  { kind: 'species', id: 'species:human', size: 'medium', speed: 30 },
  {
    kind: 'class',
    id: 'class:fighter',
    hitDie: 10,
    primaryAbility: ['str'],
    saveProficiencies: ['str', 'con'],
  },
  {
    kind: 'background',
    id: 'background:soldier',
    skillProficiencies: ['athletics'],
  },
  {
    kind: 'equipment',
    id: 'equipment:longsword',
    category: 'weapon',
    costCp: 1500,
    weight: 3,
  },
  {
    kind: 'spell',
    id: 'spell:fire-bolt',
    level: 0,
    school: 'evocation',
    classes: ['wizard'],
  },
  {
    kind: 'monster',
    id: 'monster:goblin',
    cr: 0.25,
    hp: 7,
    ac: 15,
    speed: 30,
    size: 'small',
  },
  { kind: 'condition', id: 'condition:prone', description: 'Lying down.' },
].map((e) => ({ ...e, ...b }));

describe('catalog entries', () => {
  test.each(catalogValid)('parses valid $kind', (e) => {
    expect(CatalogEntrySchema.parse(e)).toEqual(e);
  });
  test.each(catalogValid)('rejects $kind missing catalogVersion', (e) => {
    const rest: Record<string, unknown> = { ...e };
    delete rest.catalogVersion;
    expect(CatalogEntrySchema.safeParse(rest).success).toBe(false);
  });
  test.each(catalogValid)('rejects $kind with non-SRD source', (e) => {
    expect(
      CatalogEntrySchema.safeParse({ ...e, srd: { source: 'other', ref: 'x' } })
        .success,
    ).toBe(false);
  });
  test('rejects malformed catalog ids', () => {
    expect(
      CatalogEntrySchema.safeParse({ ...catalogValid[0], id: 'Species:Bad_ID' })
        .success,
    ).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({ ...catalogValid[0], id: 'class:human' })
        .success,
    ).toBe(false);
  });
  test('rejects unknown kind', () => {
    expect(
      CatalogEntrySchema.safeParse({ ...b, id: 'x', kind: 'beholder' }).success,
    ).toBe(false);
  });
});

const character = {
  id: uuid,
  name: 'Ayla',
  speciesId: 'species:human',
  classId: 'class:fighter',
  backgroundId: 'background:soldier',
  level: 1,
  abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
  proficiencies: { skills: ['athletics'], saves: ['str', 'con'], tools: [] },
  equipment: [{ itemId: 'equipment:longsword', qty: 1, equipped: true }],
  spellsKnown: [],
  spellsPrepared: [],
  slots: { '1': { max: 2, used: 0 } },
  hp: { current: 12, max: 12, temp: 0 },
  conditions: [{ conditionId: 'condition:prone' }],
};

test('Character parses valid and rejects invalid', () => {
  expect(CharacterSchema.parse(character)).toEqual(character);
  expect(CharacterSchema.safeParse({ ...character, level: 21 }).success).toBe(
    false,
  );
  expect(
    CharacterSchema.safeParse({
      ...character,
      slots: { '0': { max: 1, used: 0 } },
    }).success,
  ).toBe(false);
});

const combat = {
  round: 1,
  turnIndex: 0,
  initiative: [{ entityId: 'a', total: 15 }],
  resources: {
    a: { action: true, bonusAction: true, reaction: true, movementLeft: 30 },
  },
  entities: [
    { id: 'a', kind: 'character', pos: { x: 1, y: 2 }, size: 1, hp: 12 },
  ],
};

test('CombatState parses valid and rejects invalid', () => {
  expect(CombatStateSchema.parse(combat)).toEqual(combat);
  expect(CombatStateSchema.safeParse({ ...combat, round: 0 }).success).toBe(
    false,
  );
  expect(
    CombatStateSchema.safeParse({
      ...combat,
      entities: [{ ...combat.entities[0], size: 0 }],
    }).success,
  ).toBe(false);
});

const p = { x: 0, y: 0 };
const events: EngineEvent[] = [
  {
    type: 'RollEvent',
    actorId: 'a',
    label: 'init',
    dice: '1d20',
    rolls: [10],
    modifier: 2,
    total: 12,
  },
  { type: 'CombatStarted', combatId: 'c', entityIds: ['a'] },
  { type: 'ConcentrationDropped', entityId: 'a' },
  { type: 'InitiativeRolled', entityId: 'a', total: 12 },
  { type: 'ReactionAvailable', entityId: 'a', trigger: 'opportunity' },
  { type: 'ReactionResolved', entityId: 'a', used: true },
  { type: 'CombatEnded', combatId: 'c' },
  { type: 'MapLoaded', mapId: 'm' },
  { type: 'EntityPlaced', entityId: 'a', pos: p },
  { type: 'EntityMoved', entityId: 'a', path: [p], cost: 5 },
  { type: 'OpportunityTriggered', moverId: 'a', attackerId: 'b' },
  { type: 'AreaResolved', cells: [p], affected: ['a'] },
  { type: 'HpChanged', entityId: 'a', delta: -3, hp: 9 },
  { type: 'ConditionApplied', entityId: 'a', conditionId: 'condition:prone' },
  { type: 'ConditionRemoved', entityId: 'a', conditionId: 'condition:prone' },
  { type: 'SlotSpent', entityId: 'a', level: 1 },
];

// Compile-time exhaustiveness: adding an event type without a case fails typecheck.
function label(e: EngineEvent): string {
  switch (e.type) {
    case 'RollEvent':
    case 'ConcentrationDropped':
    case 'CombatStarted':
    case 'InitiativeRolled':
    case 'ReactionAvailable':
    case 'ReactionResolved':
    case 'CombatEnded':
    case 'MapLoaded':
    case 'EntityPlaced':
    case 'EntityMoved':
    case 'OpportunityTriggered':
    case 'AreaResolved':
    case 'HpChanged':
    case 'ConditionApplied':
    case 'ConditionRemoved':
    case 'SlotSpent':
      return e.type;
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

describe('engine events', () => {
  test.each(events)('parses $type', (e) => {
    expect(EngineEventSchema.parse(e)).toEqual(e);
    expect(label(e)).toBe(e.type);
  });
  test.each(events)('rejects $type with bad payload', (e) => {
    expect(EngineEventSchema.safeParse({ type: e.type }).success).toBe(false);
  });
  test('rejects unknown type', () => {
    expect(EngineEventSchema.safeParse({ type: 'Nope' }).success).toBe(false);
  });
});
