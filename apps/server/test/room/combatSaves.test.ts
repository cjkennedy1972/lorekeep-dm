import type { CharacterInput } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/room-tools';
import { describe, expect, it } from 'vitest';
import { attacksFor } from '../../src/room/combatBootstrap.js';

const catalog = loadCatalog();
const place = { pos: { x: 0, y: 0 }, size: 1, hp: 10, maxHp: 10, ac: 10 };

describe('saving throw bonuses on combat entities', () => {
  it('gives a PC its derived saves, with proficiency where it has one', () => {
    const character = {
      id: 'ent_pc',
      level: 1,
      abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
      proficiencies: { skills: [], saves: ['con'], tools: [] },
      equipment: [],
      hp: { max: 10, current: 10 },
      slots: {},
      spellsKnown: [],
      spellsPrepared: [],
    } as unknown as CharacterInput;
    const { saves } = attacksFor(
      { id: 'ent_pc', team: 'party', speed: 30, ...place },
      character,
      {},
      catalog,
    );
    expect(saves).toMatchObject({ str: 0, dex: 0, con: 4 });
  });

  it('gives a monster its catalog save bonuses', () => {
    const { saves } = attacksFor(
      {
        id: 'ent_brass-dragon-wyrmling_1',
        team: 'dragons',
        speed: 30,
        ...place,
      },
      undefined,
      {},
      catalog,
    );
    expect(saves).toEqual({ dex: 2, wis: 2 });
  });

  it('falls back to the ability modifier when the catalog omits that save', () => {
    const monster = catalog.get('monster', 'monster:brass-dragon-wyrmling')!;
    const altered = { ...monster, saves: { wis: 2 } };
    const noDexCatalog = {
      ...catalog,
      get: (kind: string, id: string) =>
        kind === 'monster' && id === altered.id
          ? altered
          : catalog.get(kind as never, id),
    };
    const { saves, abilities } = attacksFor(
      {
        id: 'ent_brass-dragon-wyrmling_1',
        team: 'dragons',
        speed: 30,
        ...place,
      },
      undefined,
      {},
      noDexCatalog,
    );
    expect(saves?.dex).toBeUndefined();
    expect(abilities?.dex).toBe(10);
  });
});
