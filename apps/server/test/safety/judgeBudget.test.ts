import { describe, expect, it } from 'vitest';
import { JudgeBudget } from '../../src/safety/judgeBudget.js';

describe('shared judge budget', () => {
  it('keeps one in-flight slot available for DM output while chat is saturated', () => {
    const budget = new JudgeBudget();
    const input = [
      budget.acquire('chat', 0),
      budget.acquire('chat', 0),
      budget.acquire('chat', 0),
    ];
    expect(input.every(Boolean)).toBe(true);
    expect(budget.acquire('action-input', 0)).toBeUndefined();
    const output = budget.acquire('output', 0);
    expect(output).toBeTypeOf('function');
    input[0]?.();
    expect(budget.acquire('action-input', 0)).toBeTypeOf('function');
    output?.();
  });

  it('reserves forty of the 240 rolling-minute calls for DM output', () => {
    const budget = new JudgeBudget();
    for (let i = 0; i < 200; i++) {
      const release = budget.acquire(i % 2 ? 'chat' : 'action-input', i);
      expect(release).toBeTypeOf('function');
      release?.();
    }
    expect(budget.acquire('chat', 200)).toBeUndefined();
    for (let i = 0; i < 40; i++) {
      const release = budget.acquire('output', 200);
      expect(release).toBeTypeOf('function');
      release?.();
    }
    expect(budget.acquire('output', 200)).toBeUndefined();
  });
});
