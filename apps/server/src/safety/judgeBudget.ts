type BudgetClass = 'input' | 'output';

const IN_FLIGHT_LIMITS: Record<BudgetClass, number> = {
  input: 3,
  output: 1,
};
const PER_MINUTE_LIMITS: Record<BudgetClass, number> = {
  input: 200,
  output: 40,
};
const WINDOW_MS = 60_000;

/** Process-wide shared judge capacity; output has an independent reserved share. */
export class JudgeBudget {
  private readonly inFlight: Record<BudgetClass, number> = {
    input: 0,
    output: 0,
  };
  private readonly calls: Record<BudgetClass, number[]> = {
    input: [],
    output: [],
  };

  acquire(
    budgetClass: BudgetClass,
    now = Date.now(),
  ): (() => void) | undefined {
    const recent = this.calls[budgetClass].filter((at) => at > now - WINDOW_MS);
    this.calls[budgetClass] = recent;
    if (
      recent.length >= PER_MINUTE_LIMITS[budgetClass] ||
      this.inFlight[budgetClass] >= IN_FLIGHT_LIMITS[budgetClass]
    )
      return undefined;
    recent.push(now);
    this.inFlight[budgetClass] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight[budgetClass] = Math.max(0, this.inFlight[budgetClass] - 1);
    };
  }
}

export const endpointJudgeBudget = new JudgeBudget();
