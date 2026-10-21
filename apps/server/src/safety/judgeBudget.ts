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
export const JUDGE_UPSTREAM_HARD_CAP_MS = 60_000;
const LOST_CALL_LIMITS: Record<CapacityClass, number> = {
  'action-input': 1,
  chat: 2,
  output: 1,
};

export type JudgeBudgetResult =
  | { kind: 'acquired'; release: () => void; markLost: () => void }
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
  private readonly unsettledLost: Record<CapacityClass, number> = {
    'action-input': 0,
    chat: 0,
    output: 0,
  };

  acquire(budgetClass: BudgetClass, now = Date.now()): JudgeBudgetResult {
    const recent = this.calls[budgetClass].filter((at) => at > now - WINDOW_MS);
    this.calls[budgetClass] = recent;
    if (
      this.unsettledLost[budgetClass] >= LOST_CALL_LIMITS[budgetClass] ||
      recent.length >= PER_MINUTE_LIMITS[budgetClass] ||
      this.inFlight[budgetClass] >= IN_FLIGHT_LIMITS[budgetClass]
    )
      return { kind: 'limited', class: budgetClass };
    recent.push(now);
    this.inFlight[budgetClass] += 1;
    const startedAt = Date.now();
    let state: 'in-flight' | 'lost' | 'settled' = 'in-flight';
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    return {
      kind: 'acquired',
      release: () => {
        if (state === 'settled') return;
        if (state === 'in-flight') this.inFlight[budgetClass] -= 1;
        else {
          this.unsettledLost[budgetClass] -= 1;
          if (lostTimer !== undefined) clearTimeout(lostTimer);
        }
        state = 'settled';
      },
      markLost: () => {
        if (state !== 'in-flight') return;
        this.inFlight[budgetClass] -= 1;
        this.unsettledLost[budgetClass] += 1;
        state = 'lost';
        const remaining = Math.max(
          0,
          startedAt + JUDGE_UPSTREAM_HARD_CAP_MS - Date.now(),
        );
        lostTimer = setTimeout(() => {
          if (state !== 'lost') return;
          this.unsettledLost[budgetClass] -= 1;
          state = 'settled';
        }, remaining);
        lostTimer.unref?.();
      },
    };
  }
}

/** ADR-032 §4: lost calls retain capacity until settlement or 60 s transport destruction. */
export async function withJudgeHardCap<T>(
  operation: Promise<T>,
  release: () => void,
  markLost: () => void = release,
  hardCapMs = JUDGE_UPSTREAM_HARD_CAP_MS,
  destroy?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Caller timeout marks the request lost; this bound destroys its transport and frees capacity.
  void operation.then(release, release);
  const hardCap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      markLost();
      try {
        destroy?.();
      } catch {
        // Capacity still recovers at the hard deadline even if transport teardown fails.
      } finally {
        release();
      }
      reject(new Error('judge upstream hard cap exceeded'));
    }, hardCapMs);
  });
  try {
    return await Promise.race([operation, hardCap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const endpointJudgeBudget = new JudgeBudget();
