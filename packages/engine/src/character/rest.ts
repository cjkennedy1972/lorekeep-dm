import type { CharacterCatalog, CharacterInput } from './types.js';
import { deriveSheet } from './derive.js';
import { roll, type RollBreakdown } from '../dice.js';
import type { RngState } from '../rng.js';

export interface RestResult {
  character: CharacterInput;
  rolls: RollBreakdown[];
  rng: RngState;
}

/** Spend available Hit Dice, adding Constitution, and cap healing at max HP. */
export function shortRest(
  char: CharacterInput,
  catalog: CharacterCatalog,
  rng: RngState,
  hitDiceToSpend = 1,
): RestResult {
  const klass = catalog.get('class', char.classId);
  if (!klass) throw new Error(`Unknown class ${char.classId}`);
  const available = char.level - (char.hitDiceSpent ?? 0);
  if (!Number.isInteger(hitDiceToSpend) || hitDiceToSpend < 0 || hitDiceToSpend > available)
    throw new Error(`Cannot spend ${hitDiceToSpend} Hit Dice; ${available} available`);

  let hp = char.hp.current;
  const rolls: RollBreakdown[] = [];
  for (let i = 0; i < hitDiceToSpend; i++) {
    const [breakdown, next] = roll(`1d${klass.hitDie}`, rng, {
      modifiers: [{ label: 'Constitution', value: Math.floor((char.abilities.con - 10) / 2) }],
    });
    rng = next;
    rolls.push(breakdown);
    hp = Math.min(char.hp.max, hp + Math.max(0, breakdown.total));
  }
  const featureUses = char.featureUses ? { ...char.featureUses } : undefined;
  if (featureUses && char.level >= 5 && char.classId === 'class:bard')
    for (const id of Object.keys(featureUses))
      if (/bardic-inspiration/.test(id)) featureUses[id] = 0;
  const slots = { ...char.slots };
  const pact = klass.pactMagic?.[char.level - 1];
  if (char.classId === 'class:warlock' && pact)
    slots[String(pact.slotLevel)] = { max: pact.slots, used: 0 };
  return {
    character: { ...char, hitDiceSpent: (char.hitDiceSpent ?? 0) + hitDiceToSpend, hp: { ...char.hp, current: hp }, slots, ...(featureUses ? { featureUses } : {}) },
    rolls,
    rng,
  };
}

/** Restore HP, expended spell slots and the SRD number of spent Hit Dice. */
export function longRest(char: CharacterInput, catalog: CharacterCatalog): CharacterInput {
  const sheet = deriveSheet(char, catalog);
  const slots = Object.fromEntries(Object.entries(char.slots).map(([level, slot]) => [level, { ...slot, used: 0 }]));
  for (const [level, max] of Object.entries(sheet.spellSlots))
    slots[level] = { max, used: 0 };
  const spent = char.hitDiceSpent ?? 0;
  const regained = Math.max(1, Math.floor(char.level / 2));
  return {
    ...char,
    hp: { ...char.hp, current: char.hp.max, temp: 0 },
    slots,
    hitDiceSpent: Math.max(0, spent - regained),
    featureUses: char.featureUses ? Object.fromEntries(Object.keys(char.featureUses).map((id) => [id, 0])) : undefined,
  };
}

/** Bardic Inspiration recovers on a short rest from level 5; other M1 recovery is long-rest based. */
export function recoverShortRestFeatures(char: CharacterInput): CharacterInput {
  if (char.level < 5) return char;
  const featureUses = { ...char.featureUses };
  for (const id of Object.keys(featureUses))
    if (/bardic-inspiration/.test(id)) featureUses[id] = 0;
  return { ...char, featureUses };
}
