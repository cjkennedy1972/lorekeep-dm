type BudgetClass = 'action-input' | 'chat' | 'output';
type CapacityClass = 'shared' | 'output';

const IN_FLIGHT_LIMITS: Record<CapacityClass, number> = {
  shared: 3,
  output: 1,
};
const PER_MINUTE_LIMITS: Record<CapacityClass, number> = {
  shared: 200,
  output: 40,
};
const WINDOW_MS = 60_000;

/** Process-wide shared judge capacity; output has an independent reserved share. */
export class JudgeBudget {
  private readonly inFlight: Record<CapacityClass, number> = {
    shared: 0,
    output: 0,
  };
  private readonly calls: Record<CapacityClass, number[]> = {
    shared: [],
    output: [],
  };

  acquire(
    budgetClass: BudgetClass,
    now = Date.now(),
  ): (() => void) | undefined {
    const capacityClass: CapacityClass =
      budgetClass === 'output' ? 'output' : 'shared';
    const recent = this.calls[capacityClass].filter(
      (at) => at > now - WINDOW_MS,
    );
    this.calls[capacityClass] = recent;
    if (
      recent.length >= PER_MINUTE_LIMITS[capacityClass] ||
      this.inFlight[capacityClass] >= IN_FLIGHT_LIMITS[capacityClass]
    )
      return undefined;
    recent.push(now);
    this.inFlight[capacityClass] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight[capacityClass] = Math.max(
        0,
        this.inFlight[capacityClass] - 1,
      );
    };
  }
}

export const endpointJudgeBudget = new JudgeBudget();
