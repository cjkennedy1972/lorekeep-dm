type BudgetClass = 'action-input' | 'chat' | 'output';
type CapacityClass = BudgetClass;

const IN_FLIGHT_LIMITS: Record<CapacityClass, number> = {
  'action-input': 1,
  chat: 2,
  output: 1,
};
const PER_MINUTE_LIMITS: Record<CapacityClass, number> = {
  'action-input': 80,
  chat: 120,
  output: 40,
};
const WINDOW_MS = 60_000;

export type JudgeBudgetResult =
  | { kind: 'acquired'; release: () => void }
  | { kind: 'limited'; class: BudgetClass };

/** Process-wide judge capacity partitioned across chat, actions, and output. */
export class JudgeBudget {
  private readonly inFlight: Record<CapacityClass, number> = {
    'action-input': 0,
    chat: 0,
    output: 0,
  };
  private readonly calls: Record<CapacityClass, number[]> = {
    'action-input': [],
    chat: [],
    output: [],
  };

  acquire(budgetClass: BudgetClass, now = Date.now()): JudgeBudgetResult {
    const recent = this.calls[budgetClass].filter((at) => at > now - WINDOW_MS);
    this.calls[budgetClass] = recent;
    if (
      recent.length >= PER_MINUTE_LIMITS[budgetClass] ||
      this.inFlight[budgetClass] >= IN_FLIGHT_LIMITS[budgetClass]
    )
      return { kind: 'limited', class: budgetClass };
    recent.push(now);
    this.inFlight[budgetClass] += 1;
    let released = false;
    return {
      kind: 'acquired',
      release: () => {
        if (released) return;
        released = true;
        this.inFlight[budgetClass] = Math.max(
          0,
          this.inFlight[budgetClass] - 1,
        );
      },
    };
  }
}

export const endpointJudgeBudget = new JudgeBudget();
