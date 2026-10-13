import { describe, expect, it } from 'vitest';
import { runOutputGate } from '../../src/safety/outputGate.js';
import type { Moderator } from '../../src/safety/moderator.js';

const allowed = {
  verdict: 'allow',
  category: 'none',
  source: 'judge',
  latencyMs: 0,
  unavailable: false,
} as const;

describe('output gate deterministic turn completion', () => {
  it('fails closed when finish returns undefined instead of hanging', async () => {
    let finishCalls = 0;
    const moderator: Moderator = {
      moderate: async () => allowed,
      startTurn: () => ({
        push: () => ({ blocked: false }),
        finish: () => {
          finishCalls++;
          return undefined as never;
        },
      }),
    };
    const gate = runOutputGate({
      stream: async function* () {
        yield 'A calm scene begins.';
      },
      regenerate: async function* () {
        yield 'This text must not be emitted.';
      },
      moderator,
      tier: 'standard',
      maxRegenerations: 0,
    });

    const events = [];
    for await (const event of gate) events.push(event);

    expect(finishCalls).toBe(1);
    expect(events.some((event) => event.kind === 'chunk')).toBe(false);
    expect(events).toContainEqual({
      kind: 'redirect',
      text: 'The narrator pauses, and the scene turns to the next thing the party notices.',
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'end',
      outcome: 'redirected',
    });
  });
});
