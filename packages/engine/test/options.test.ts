import { describe, expect, test } from 'vitest';
import { rleEncode, type Battlemap } from '@game/schema';
import {
  legalOptions,
  resolveOption,
  suggestAreaTargets,
  type OptionsState,
} from '../src/map/options.js';
import type { Catalog } from '../src/catalog/types.js';

const map: Battlemap = {
  mapId: 'options',
  w: 6,
  h: 6,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: rleEncode(Array(36).fill(0)),
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
const state: OptionsState = {
  map,
  entities: [
    {
      id: 'hero',
      pos: { x: 1, y: 1 },
      size: 1,
      team: 'heroes',
      attacks: [{ id: 'sword', name: 'Sword' }],
    },
    {
      id: 'foe',
      pos: { x: 2, y: 1 },
      size: 1,
      team: 'foes',
      hp: 8,
      name: 'Goblin',
    },
    { id: 'down', pos: { x: 3, y: 1 }, size: 1, team: 'foes', hp: 0 },
  ],
  resources: { hero: { movementLeft: 10, action: true } },
};

describe('engine-issued legal action options', () => {
  test('provides resolvable attack/move/end handles and rejects stale or unknown ids', () => {
    const result = legalOptions(state, 'hero');
    expect('actions' in result).toBe(true);
    if (!('actions' in result)) return;
    const attack = result.actions.find((action) => action.kind === 'attack');
    const move = result.actions.find((action) => action.kind === 'move');
    expect(attack && resolveOption(state, 'hero', attack.optionId)).toEqual({
      kind: 'attack',
      attackerId: 'hero',
      targetId: 'foe',
      attackId: 'sword',
    });
    expect(move && resolveOption(state, 'hero', move.optionId)).toMatchObject({
      kind: 'move',
      entityId: 'hero',
    });
    expect(resolveOption(state, 'hero', 'made-up')).toMatchObject({
      error: expect.any(String),
      hint: expect.any(String),
    });
    const moved: OptionsState = {
      ...state,
      entities: state.entities.map((entity) =>
        entity.id === 'foe' ? { ...entity, pos: { x: 4, y: 4 } } : entity,
      ),
    };
    expect(
      attack && resolveOption(moved, 'hero', attack.optionId),
    ).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
    expect(
      result.actions.some(
        (action) => 'targetId' in action && action.targetId === 'down',
      ),
    ).toBe(false);
  });

  test('unconscious actors have no legal actions', () => {
    expect(
      legalOptions(
        {
          ...state,
          entities: [
            ...state.entities,
            { id: 'sleeping', pos: { x: 0, y: 0 }, size: 1, hp: 0 },
          ],
        },
        'sleeping',
      ),
    ).toEqual({ actions: [] });
    expect(
      legalOptions({ ...state, conditions: { hero: ['unconscious'] } }, 'hero'),
    ).toEqual({ actions: [] });
  });

  test('suggests deterministic area anchors with affected entity preview', () => {
    const catalog = {
      get: (_kind: string, id: string) =>
        id === 'spell:burst' ? { id } : undefined,
    } as unknown as Catalog;
    const withSpell: OptionsState = {
      ...state,
      catalog,
      spells: [{ id: 'spell:burst', template: { shape: 'sphere', size: 5 } }],
    };
    const first = suggestAreaTargets(withSpell, 'hero', 'spell:burst');
    const second = suggestAreaTargets(
      { ...withSpell, entities: [...withSpell.entities].reverse() },
      'hero',
      'spell:burst',
    );
    expect(first).toEqual(second);
    expect(
      'options' in first &&
        first.options.some((option) =>
          option.affected.some((entity) => entity.id === 'foe'),
        ),
    ).toBe(true);
    expect(
      suggestAreaTargets(withSpell, 'missing', 'spell:burst'),
    ).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
  });
});
