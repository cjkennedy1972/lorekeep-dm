import { describe, expect, it } from 'vitest';
import { JudgeBudget } from '../../src/safety/judgeBudget.js';

describe('shared judge budget', () => {
  it('caps chat at two slots and preserves one action-input slot', () => {
    const budget = new JudgeBudget();
    const chat = [budget.acquire('chat', 0), budget.acquire('chat', 0)];
    expect(chat.map((result) => result.kind)).toEqual(['acquired', 'acquired']);
    expect(budget.acquire('chat', 0)).toEqual({
      kind: 'limited',
      class: 'chat',
    });
    const action = budget.acquire('action-input', 0);
    expect(action.kind).toBe('acquired');
    expect(budget.acquire('action-input', 0)).toEqual({
      kind: 'limited',
      class: 'action-input',
    });
    const output = budget.acquire('output', 0);
    expect(output.kind).toBe('acquired');
    if (action.kind === 'acquired') action.release();
    if (output.kind === 'acquired') output.release();
    for (const item of chat) if (item.kind === 'acquired') item.release();
  });

  it('caps chat at 120/min, actions at 80/min and reserves output at 40/min', () => {
    const budget = new JudgeBudget();
    for (let i = 0; i < 120; i++) {
      const result = budget.acquire('chat', i);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') result.release();
    }
    expect(budget.acquire('chat', 120)).toEqual({
      kind: 'limited',
      class: 'chat',
    });
    for (let i = 0; i < 80; i++) {
      const result = budget.acquire('action-input', i);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') result.release();
    }
    expect(budget.acquire('action-input', 80)).toEqual({
      kind: 'limited',
      class: 'action-input',
    });
    for (let i = 0; i < 40; i++) {
      const result = budget.acquire('output', 200);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') result.release();
    }
    expect(budget.acquire('output', 200)).toEqual({
      kind: 'limited',
      class: 'output',
    });
  });
});
