import type { LlmRequest, ToolMode } from './adapter.js';

/** Rolling error-rate downgrade; callers explicitly observe unsupported mode. */
export class ToolModeCircuitBreaker {
  private readonly outcomes: boolean[] = [];
  private current: ToolMode | 'unsupported';

  constructor(
    mode: ToolMode | 'unsupported',
    private readonly windowSize = 20,
    private readonly threshold = 0.25,
  ) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new RangeError('windowSize must be a positive integer');
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('threshold must be between 0 and 1');
    }
    this.current = mode;
  }

  get mode(): ToolMode | 'unsupported' {
    return this.current;
  }

  recordToolResult(success: boolean): ToolMode | 'unsupported' {
    if (this.current === 'unsupported') return this.current;
    this.outcomes.push(success);
    if (this.outcomes.length > this.windowSize) this.outcomes.shift();
    const failures = this.outcomes.filter((outcome) => !outcome).length;
    if (
      this.outcomes.length === this.windowSize &&
      failures / this.windowSize > this.threshold
    ) {
      this.current = this.current === 'native' ? 'json-schema' : 'unsupported';
      this.outcomes.length = 0;
    }
    return this.current;
  }

  request(request: LlmRequest): LlmRequest {
    if (this.current === 'unsupported') {
      throw new Error('LLM endpoint has no supported tool mode');
    }
    return { ...request, toolMode: this.current };
  }
}
