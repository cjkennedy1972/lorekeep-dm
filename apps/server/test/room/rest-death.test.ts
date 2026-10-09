import { describe, expect, it } from 'vitest';
import { nextDie, type CharacterInput } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/room-tools';
import { resolveSoloRest } from '../../src/room/rest.js';
import {
  failForward,
  resolveDeathSave,
  retryFromCheckpoint,
} from '../../src/room/death.js';

const catalog = loadCatalog();
const hero: CharacterInput = {
  id: 'ent_aria',
  name: 'Aria',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 2,
  abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:burning-hands'],
  spellsPrepared: ['spell:burning-hands'],
  slots: { '1': { max: 3, used: 2 } },
  hp: { current: 1, max: 20, temp: 4 },
  hitDiceSpent: 1,
  conditions: [],
};
const game = (character = hero) => ({
  characters: { account: character },
  gameEngine: { actors: { [character.id]: character } },
});

describe('Room solo rest and death flow', () => {
  it('applies short-rest hit dice and long-rest SRD recovery', () => {
    const short = resolveSoloRest(
      game(),
      'account',
      'short',
      catalog,
      1,
      0,
      1234,
    );
    const afterShort = (
      short.gameState.characters as Record<string, CharacterInput>
    ).account;
    expect(afterShort.hp.current).toBeGreaterThan(1);
    expect(afterShort.hitDiceSpent).toBe(2);
    expect(short.events.map((event) => event.type)).toContain('RestCompleted');
    const long = resolveSoloRest(
      { characters: { account: afterShort } },
      'account',
      'long',
      catalog,
      0,
      0,
      1234,
    );
    const afterLong = (
      long.gameState.characters as Record<string, CharacterInput>
    ).account;
    expect(afterLong.hp).toEqual({ current: 20, max: 20, temp: 0 });
    expect(afterLong.slots['1']).toEqual({ max: 3, used: 0 });
    expect(afterLong.hitDiceSpent).toBe(1);
  });

  it('can interrupt a rest without applying recovery', () => {
    const interrupted = resolveSoloRest(
      game(),
      'account',
      'long',
      catalog,
      0,
      1,
      1,
    );
    expect(
      (interrupted.gameState.characters as Record<string, CharacterInput>)
        .account,
    ).toEqual(hero);
    expect(interrupted.events[0]?.type).toBe('RestInterrupted');
  });

  it('uses seeded engine death saves and announces stable/dead outcomes', () => {
    const seedFor = (wanted: (die: number) => boolean) => {
      for (let seed = 0; seed < 100_000; seed++)
        if (wanted(nextDie(seed, 20)[0])) return seed;
      throw new Error('seed not found');
    };
    const success = resolveDeathSave(
      { characters: { account: { ...hero, hp: { ...hero.hp, current: 0 } } } },
      'account',
      seedFor((die) => die >= 10 && die < 20),
    );
    expect(success.events[0]?.type).toBe('DeathSaveRolled');
    expect(success.prompt).toBe('death-save');
    const dead = resolveDeathSave(
      {
        characters: { account: { ...hero, hp: { ...hero.hp, current: 0 } } },
        deathSaves: {
          account: {
            successes: 0,
            failures: 2,
            stable: false,
            dead: false,
            hp: 0,
          },
        },
      },
      'account',
      seedFor((die) => die < 10 && die !== 1),
    );
    expect(dead.events.map((event) => event.type)).toContain('CharacterDied');
    expect(dead.prompt).toBe('tpk-choice');
  });

  it('restores a checkpoint with a different retry seed and fail-forwards without dice', () => {
    const checkpoint = { hp: 10, seed: 42 };
    expect(retryFromCheckpoint(checkpoint, 42, 42)).toEqual({
      ...checkpoint,
      seed: 43,
    });
    const result = failForward(
      { seed: 42 },
      'account',
      'The tale continues in exile.',
    );
    expect(result.gameState.seed).toBe(42);
    expect(result.events[0]?.type).toBe('FailForwardChosen');
  });
});
