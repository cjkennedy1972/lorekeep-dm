import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';

/**
 * Scripted DM that records every request it is sent. Optionally holds each
 * completion until `release()` is called, which lets scenarios queue actions
 * while a round is resolving.
 */
export class CapturingDm {
  readonly requests: LlmRequest[] = [];
  private gate?: Promise<void>;
  private open?: () => void;

  /** Hold all subsequent DM completions until release(). */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  /** Everything the DM has been asked to read, serialised for substring checks. */
  promptText(): string {
    return JSON.stringify(this.requests);
  }

  adapter(): LlmAdapter {
    return {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      complete: (request: LlmRequest) => this.run(request),
    };
  }

  private async *run(request: LlmRequest): AsyncGenerator<LlmChunk> {
    this.requests.push(request);
    if (this.gate) await this.gate;
    const chunk: LlmChunk = { type: 'text', delta: 'The party presses on.' };
    yield chunk;
  }
}
