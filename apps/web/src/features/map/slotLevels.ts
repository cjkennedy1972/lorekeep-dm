type SlotState = Record<string, { max: number; used: number }>;

/**
 * Slot levels a caster can submit right now, lowest first. Level 0 is the cantrip choice, which spends
 * no slot; the server rejects a cantrip at any other level and a leveled spell at 0.
 */
export function castableSlotLevels(slots: SlotState | undefined): number[] {
  const leveled = Object.entries(slots ?? {})
    .filter(([, state]) => state.used < state.max)
    .map(([level]) => Number(level))
    .filter((level) => Number.isInteger(level) && level >= 1 && level <= 9)
    .sort((a, b) => a - b);
  return [0, ...leveled];
}

/**
 * The level a cast submits before the seat picks another. The lowest leveled slot keeps the common
 * case casting at 1; with no leveled slot left, the cantrip choice is the only one that can go out.
 */
export function defaultSlotLevel(levels: number[]): number {
  return levels.find((level) => level >= 1) ?? 0;
}
