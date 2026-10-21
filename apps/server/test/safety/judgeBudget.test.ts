import { describe, expect, it, vi } from 'vitest';
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

  it('limits lost calls per class and leaves other classes available', () => {
    const budget = new JudgeBudget();
    for (let i = 0; i < 2; i++) {
      const slot = budget.acquire('chat');
      expect(slot.kind).toBe('acquired');
      if (slot.kind === 'acquired') slot.markLost();
    }
    expect(budget.acquire('chat')).toEqual({ kind: 'limited', class: 'chat' });
    const action = budget.acquire('action-input');
    const output = budget.acquire('output');
    expect(action.kind).toBe('acquired');
    expect(output.kind).toBe('acquired');
    if (action.kind === 'acquired') action.markLost();
    if (output.kind === 'acquired') output.markLost();
    expect(budget.acquire('action-input')).toEqual({
      kind: 'limited',
      class: 'action-input',
    });
    expect(budget.acquire('output')).toEqual({
      kind: 'limited',
      class: 'output',
    });
  });

  it('recovers a class when an unsettled lost call reaches its 60-second destruction bound', async () => {
    vi.useFakeTimers();
    const budget = new JudgeBudget();
    const lost = budget.acquire('action-input');
    expect(lost.kind).toBe('acquired');
    if (lost.kind !== 'acquired') return;
    lost.markLost();
    expect(budget.acquire('action-input')).toEqual({
      kind: 'limited',
      class: 'action-input',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const recovered = budget.acquire('action-input');
    expect(recovered.kind).toBe('acquired');
    if (recovered.kind === 'acquired') recovered.release();
    vi.useRealTimers();
  });

  it('keeps an aborted caller slot until settle, then transitions unsettled work to lost at 10 seconds', async () => {
    vi.useFakeTimers();
    const budget = new JudgeBudget();
    const first = budget.acquire('chat');
    const second = budget.acquire('chat');
    expect(first.kind).toBe('acquired');
    expect(second.kind).toBe('acquired');
    if (first.kind !== 'acquired' || second.kind !== 'acquired') return;

    // Caller abort is only a delayed markLost; it must not release admission immediately.
    const callerAbortTimer = setTimeout(first.markLost, 10_000);
    expect(budget.acquire('chat')).toEqual({ kind: 'limited', class: 'chat' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(budget.acquire('chat')).toEqual({ kind: 'limited', class: 'chat' });
    await vi.advanceTimersByTimeAsync(1);
    const replacement = budget.acquire('chat');
    expect(replacement.kind).toBe('acquired');
    if (replacement.kind === 'acquired') replacement.release();
    const action = budget.acquire('action-input');
    expect(action.kind).toBe('acquired');
    if (action.kind === 'acquired') action.release();

    first.release();
    clearTimeout(callerAbortTimer);
    second.release();
    const recovered = budget.acquire('chat');
    expect(recovered.kind).toBe('acquired');
    if (recovered.kind === 'acquired') recovered.release();
    vi.useRealTimers();
  });

  it('releases an aborted caller slot on late upstream settlement before the 10-second lost transition', async () => {
    vi.useFakeTimers();
    const budget = new JudgeBudget();
    const slot = budget.acquire('chat');
    expect(slot.kind).toBe('acquired');
    if (slot.kind !== 'acquired') return;
    let resolve!: () => void;
    const operation = new Promise<void>((r) => (resolve = r));
    const abortTimer = setTimeout(slot.markLost, 10_000);
    void operation.then(() => {
      clearTimeout(abortTimer);
      slot.release();
    });
    resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const recovered = budget.acquire('chat');
    expect(recovered.kind).toBe('acquired');
    if (recovered.kind === 'acquired') recovered.release();
    vi.useRealTimers();
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
