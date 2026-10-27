type BudgetClass = 'action-input' | 'chat' | 'output';
type CapacityClass = BudgetClass;

const IN_FLIGHT_LIMITS: Record<CapacityClass, number> = {
  'action-input': 1,
  chat: 2,
  output: 4,
};
const PER_MINUTE_LIMITS: Record<CapacityClass, number> = {
  'action-input': 80,
  chat: 120,
  output: 160,
};
const WINDOW_MS = 60_000;
export const JUDGE_UPSTREAM_HARD_CAP_MS = 60_000;
const LOST_CALL_LIMITS: Partial<Record<CapacityClass, number>> = {
  'action-input': 1,
  chat: 2,
};
const OUTPUT_SESSION_PER_MINUTE_LIMIT = 60;
export const OUTPUT_NO_SESSION_BUCKET = 'output-gate-no-session';
const OUTPUT_NO_SESSION_PER_MINUTE_LIMIT = 5;

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
  private readonly outputCallsBySession = new Map<string, number[]>();

  acquire(
    budgetClass: BudgetClass,
    now = Date.now(),
    sessionId = OUTPUT_NO_SESSION_BUCKET,
  ): JudgeBudgetResult {
    const recent = this.calls[budgetClass].filter((at) => at > now - WINDOW_MS);
    this.calls[budgetClass] = recent;
    const lostLimit = LOST_CALL_LIMITS[budgetClass];
    if (budgetClass === 'output') {
      // Global output admission limits successful keys to at most 160/minute, so
      // this opportunistic pruning keeps per-session history bounded as tables churn.
      for (const [key, timestamps] of this.outputCallsBySession) {
        const active = timestamps.filter((at) => at > now - WINDOW_MS);
        if (active.length === 0) this.outputCallsBySession.delete(key);
        else this.outputCallsBySession.set(key, active);
      }
    }
    const sessionCalls =
      budgetClass === 'output'
        ? (this.outputCallsBySession.get(sessionId) ?? [])
        : undefined;
    const sessionLimit =
      sessionId === OUTPUT_NO_SESSION_BUCKET
        ? OUTPUT_NO_SESSION_PER_MINUTE_LIMIT
        : OUTPUT_SESSION_PER_MINUTE_LIMIT;
    if (
      (lostLimit !== undefined &&
        this.unsettledLost[budgetClass] >= lostLimit) ||
      recent.length >= PER_MINUTE_LIMITS[budgetClass] ||
      this.inFlight[budgetClass] >= IN_FLIGHT_LIMITS[budgetClass] ||
      (sessionCalls !== undefined && sessionCalls.length >= sessionLimit)
    )
      return { kind: 'limited', class: budgetClass };
    recent.push(now);
    if (sessionCalls !== undefined) {
      sessionCalls.push(now);
      this.outputCallsBySession.set(sessionId, sessionCalls);
    }
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
          if (budgetClass === 'output') this.inFlight[budgetClass] -= 1;
          if (lostTimer !== undefined) clearTimeout(lostTimer);
        }
        state = 'settled';
      },
      markLost: () => {
        if (state !== 'in-flight') return;
        if (budgetClass !== 'output') this.inFlight[budgetClass] -= 1;
        this.unsettledLost[budgetClass] += 1;
        state = 'lost';
        const remaining = Math.max(
          0,
          startedAt + JUDGE_UPSTREAM_HARD_CAP_MS - Date.now(),
        );
        lostTimer = setTimeout(() => {
          if (state !== 'lost') return;
          this.unsettledLost[budgetClass] -= 1;
          if (budgetClass === 'output') this.inFlight[budgetClass] -= 1;
          state = 'settled';
        }, remaining);
        lostTimer.unref?.();
      },
    };
  }
}

/** ADR-032 §4: after a 10 s abort grace, unsettled calls count as lost until settlement or the 60 s hard cap. */
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
