import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEndpointJudge,
  createInputGate,
} from '../../src/safety/inputGate.js';
import {
  endpointJudgeBudget,
  JudgeBudget,
} from '../../src/safety/judgeBudget.js';
import { createConfiguredAdapter } from '../../src/llm/config.js';
import { parseVerdictReply } from '../../src/safety/moderator.js';

vi.mock('../../src/llm/config.js', () => ({
  createEndpointEgress: vi.fn(() => ({})),
  createConfiguredAdapter: vi.fn(),
}));

const ALLOW = '{"verdict":"allow","category":"none"}';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function dbStub() {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  } as never;
}

function setupAdapter() {
  const pending: ReturnType<typeof deferred<void>>[] = [];
  const complete = vi.fn(() => {
    const hold = deferred<void>();
    pending.push(hold);
    return (async function* () {
      await hold.promise;
      yield { type: 'text' as const, delta: ALLOW };
    })();
  });
  vi.mocked(createConfiguredAdapter).mockResolvedValue({
    complete,
  } as never);
  return { complete, pending };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(createConfiguredAdapter).mockReset();
});

describe('production endpoint judge wrapper', () => {
  it('maps a direction=output request to the output budget class', async () => {
    const adapter = setupAdapter();
    const acquire = vi.spyOn(JudgeBudget.prototype, 'acquire');
    const judge = createEndpointJudge(dbStub());
    const verdict = judge.moderate({
      text: 'The room is quiet.',
      tier: 'standard',
      direction: 'output',
    });
    await vi.waitFor(() => expect(adapter.complete).toHaveBeenCalledTimes(1));
    adapter.pending[0]!.resolve();
    await expect(verdict).resolves.toMatchObject({ verdict: 'allow' });
    expect(acquire).toHaveBeenCalledWith('output');
  });

  it('does not parse a typed capacity result from the production wrapper', async () => {
    const parser = vi.fn(parseVerdictReply);
    const outputSlot = endpointJudgeBudget.acquire('output');
    expect(outputSlot.kind).toBe('acquired');
    if (outputSlot.kind !== 'acquired') return;
    const judge = createEndpointJudge(dbStub(), parser);

    await expect(
      judge.moderate({
        text: 'Narration.',
        tier: 'standard',
        direction: 'output',
      }),
    ).resolves.toMatchObject({
      unavailable: true,
      capacityLimited: 'output',
    });
    expect(parser).not.toHaveBeenCalled();
    outputSlot.release();
  });

  it('reserves an action-input slot through the real gate while chat slots are saturated', async () => {
    const adapter = setupAdapter();
    const acquire = vi.spyOn(JudgeBudget.prototype, 'acquire');
    const db = dbStub();
    const gate = createInputGate({
      db,
      moderator: createEndpointJudge(db),
      log: { warn: vi.fn() },
    });
    const firstChat = gate.checkChat!({
      text: 'A short message.',
      surface: 'chat',
      accountId: 'a1',
    });
    const secondChat = gate.checkChat!({
      text: 'Another message.',
      surface: 'chat',
      accountId: 'a2',
    });
    await vi.waitFor(() => expect(adapter.complete).toHaveBeenCalledTimes(2));

    const action = gate.check({
      text: 'I open the door.',
      surface: 'player-action',
      accountId: 'a3',
    });
    await vi.waitFor(() => expect(adapter.complete).toHaveBeenCalledTimes(3));
    expect(acquire.mock.calls.map(([budgetClass]) => budgetClass)).toEqual([
      'chat',
      'chat',
      'action-input',
    ]);

    adapter.pending.forEach((request) => request.resolve());
    await expect(action).resolves.toBe('allow');
    await expect(Promise.all([firstChat, secondChat])).resolves.toMatchObject([
      { decision: 'allow' },
      { decision: 'allow' },
    ]);
  });

  it('keeps a timed-out caller slot until a late upstream request settles', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const judge = createEndpointJudge(dbStub());
    const chatRequest = (text: string) =>
      judge.moderate({
        text,
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
      });
    const first = chatRequest('First chat request.');
    const second = chatRequest('Second chat request.');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_500);
    await expect(first).resolves.toMatchObject({ unavailable: true });
    await expect(second).resolves.toMatchObject({ unavailable: true });
    await expect(
      chatRequest('Must be capacity-limited.'),
    ).resolves.toMatchObject({
      capacityLimited: 'chat',
      unavailable: true,
    });
    expect(adapter.complete).toHaveBeenCalledTimes(2);

    adapter.pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const third = chatRequest('A slot is free after upstream settle.');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    adapter.pending[1]!.resolve();
    adapter.pending[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(third).resolves.toMatchObject({ verdict: 'allow' });
    expect(endpointJudgeBudget).toBeDefined();
  });
});
