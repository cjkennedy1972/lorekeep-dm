import type { Character, CombatState } from '@game/schema';

export interface ProjectionInput {
  characters: readonly Character[];
  combat?: {
    state: CombatState;
    description: string;
    verbosity?: 'standard' | 'brief';
  };
}

/** Compact, deterministic character facts plus engine-authored combat description. */
export function projectState(input: ProjectionInput): string {
  const characters = [...input.characters]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((character) => ({
      id: character.id,
      name: character.name,
      hp: character.hp,
      conditions: character.conditions
        .map((condition) => condition.conditionId)
        .sort(),
      slots: character.slots,
    }));
  const projection: Record<string, unknown> = { characters };
  if (input.combat) {
    projection.combat = {
      round: input.combat.state.round,
      turnIndex: input.combat.state.turnIndex,
      initiative: input.combat.state.initiative,
      description: input.combat.description,
    };
  }
  return stableJson(projection);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
