import { describe, expect, it } from 'vitest';
import { validateCharacter } from '../src/character/validate.js';
import type {
  CharacterCatalog,
  CharacterInput,
} from '../src/character/types.js';

const catalog = {
  entries: [],
  get: (kind: string, id: string) =>
    kind === 'condition' && id === 'condition:poisoned'
      ? { kind: 'condition', id, name: 'Poisoned' }
      : undefined,
  getAny: () => undefined,
} as unknown as CharacterCatalog;

function withConditions(
  conditions: CharacterInput['conditions'],
): CharacterInput {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Test',
    speciesId: 'species:human',
    classId: 'class:fighter',
    backgroundId: 'background:soldier',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiencies: { skills: [], saves: [], tools: [] },
    equipment: [],
    spellsKnown: [],
    spellsPrepared: [],
    slots: {},
    hp: { current: 1, max: 1, temp: 0 },
    conditions,
  };
}

const conditionViolations = (conditions: CharacterInput['conditions']) =>
  validateCharacter(withConditions(conditions), catalog).filter(
    (v) => v.code === 'UNKNOWN_CONDITION',
  );

describe('character condition validation', () => {
  it('rejects a condition id that is not in the closed catalog', () => {
    const violations = conditionViolations([
      { conditionId: 'condition:loli', source: 'UNMODERATED_SOURCE_MARKER' },
    ]);
    expect(violations).toEqual([
      {
        code: 'UNKNOWN_CONDITION',
        path: 'conditions',
        message: 'Unknown condition condition:loli',
      },
    ]);
  });

  it('accepts a catalog condition id with a free-text source', () => {
    expect(
      conditionViolations([
        { conditionId: 'condition:poisoned', source: 'a giant spider bite' },
      ]),
    ).toEqual([]);
  });
});
