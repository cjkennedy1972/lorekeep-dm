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
  const destroy = vi.fn();
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
    destroy,
  } as never);
  return { complete, destroy, pending };
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
      failClosedRow: 'tier',
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

  it('holds an aborted chat slot for 10 seconds, then counts it lost', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const judge = createEndpointJudge(dbStub());
    const abort = new AbortController();
    const chatRequest = (text: string, signal?: AbortSignal) =>
      judge.moderate({
        text,
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
        signal,
      });

    const first = chatRequest('Caller-aborted chat.', abort.signal);
    const second = chatRequest('A second chat fills the other in-flight slot.');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(2);
    abort.abort();
    await expect(first).resolves.toMatchObject({ unavailable: true });

    await vi.advanceTimersByTimeAsync(9_999);
    await expect(second).resolves.toMatchObject({ unavailable: true });
    await expect(
      chatRequest('Still at the in-flight limit.'),
    ).resolves.toMatchObject({
      capacityLimited: 'chat',
      unavailable: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    const third = chatRequest(
      'The first call moved out of in-flight capacity.',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    adapter.pending[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(third).resolves.toMatchObject({ verdict: 'allow' });

    await vi.advanceTimersByTimeAsync(4_500);
    await expect(
      chatRequest('Both unsettled calls are now counted as lost.'),
    ).resolves.toMatchObject({
      capacityLimited: 'chat',
      unavailable: true,
    });

    adapter.pending[0]!.resolve();
    adapter.pending[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('clears the caller-abort grace timer and releases the slot when upstream settles early', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const judge = createEndpointJudge(dbStub());
    const abort = new AbortController();
    const request = judge.moderate({
      text: 'Caller-aborted but promptly settled.',
      tier: 'standard',
      direction: 'input',
      budgetClass: 'chat',
      signal: abort.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(request).resolves.toMatchObject({ unavailable: true });
    adapter.pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const recovered = judge.moderate({
      text: 'The settled slot is available immediately.',
      tier: 'standard',
      direction: 'input',
      budgetClass: 'chat',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(2);
    adapter.pending[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toMatchObject({ verdict: 'allow' });
    await vi.advanceTimersByTimeAsync(10_000);
    const afterGrace = judge.moderate({
      text: 'No stale lost-call count remains.',
      tier: 'standard',
      direction: 'input',
      budgetClass: 'chat',
    });
    await vi.advanceTimersByTimeAsync(0);
    adapter.pending[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(afterGrace).resolves.toMatchObject({ verdict: 'allow' });
  });

  it('destroys an aborted unsettled upstream at 60 seconds and releases its lost-call count', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const judge = createEndpointJudge(dbStub());
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const request = (text: string, signal?: AbortSignal) =>
      judge.moderate({
        text,
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
        signal,
      });
    const result = request(
      'First caller aborts while upstream remains unsettled.',
      firstAbort.signal,
    );
    const second = request(
      'Second caller aborts while upstream remains unsettled.',
      secondAbort.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    firstAbort.abort();
    secondAbort.abort();
    await expect(result).resolves.toMatchObject({ unavailable: true });
    await expect(second).resolves.toMatchObject({ unavailable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(
      request('Lost-call capacity is still held.'),
    ).resolves.toMatchObject({
      capacityLimited: 'chat',
      unavailable: true,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(adapter.destroy).toHaveBeenCalledTimes(2);

    const recovered = request('Capacity returns after transport destruction.');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    adapter.pending[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toMatchObject({ verdict: 'allow' });
    adapter.pending[0]!.resolve();
    adapter.pending[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps action and output verdicts available after chat lost-call capacity is full', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const judge = createEndpointJudge(dbStub());
    const chat = (text: string) =>
      judge.moderate({
        text,
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
      });
    const first = chat('First chat request.');
    const second = chat('Second chat request.');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toMatchObject({ unavailable: true });
    await expect(second).resolves.toMatchObject({ unavailable: true });

    const action = judge.moderate({
      text: 'I open the door.',
      tier: 'standard',
      direction: 'input',
      budgetClass: 'action-input',
    });
    const output = judge.moderate({
      text: 'The door opens.',
      tier: 'standard',
      direction: 'output',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(4);
    adapter.pending[2]!.resolve();
    adapter.pending[3]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(action).resolves.toMatchObject({ verdict: 'allow' });
    await expect(output).resolves.toMatchObject({ verdict: 'allow' });
    adapter.pending[0]!.resolve();
    adapter.pending[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('holds DM output when its lost-call capacity is full', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const parser = vi.fn(parseVerdictReply);
    const judge = createEndpointJudge(dbStub(), parser);
    const output = (text: string) =>
      judge.moderate({ text, tier: 'standard', direction: 'output' });
    const lost = output('A narration request that never settles.');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_500);
    await expect(lost).resolves.toMatchObject({ unavailable: true });

    await expect(
      output('The next narration must be held.'),
    ).resolves.toMatchObject({
      unavailable: true,
      capacityLimited: 'output',
      failClosedRow: 'tier',
    });
    expect(parser).not.toHaveBeenCalled();
    adapter.pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('destroys a never-settling upstream at 60s, recovers capacity, and discards its late verdict', async () => {
    vi.useFakeTimers();
    const adapter = setupAdapter();
    const parser = vi.fn(parseVerdictReply);
    const judge = createEndpointJudge(dbStub(), parser);
    const request = (text: string) =>
      judge.moderate({
        text,
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
      });
    const result = request('A slow chat request.');
    const secondLost = request('A second slow chat request.');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_500);
    await expect(result).resolves.toMatchObject({ unavailable: true });
    await expect(secondLost).resolves.toMatchObject({ unavailable: true });
    expect(parser).not.toHaveBeenCalled();
    await expect(
      judge.moderate({
        text: 'Still busy until destruction.',
        tier: 'standard',
        direction: 'input',
        budgetClass: 'chat',
      }),
    ).resolves.toMatchObject({ capacityLimited: 'chat' });
    await vi.advanceTimersByTimeAsync(55_500);
    expect(adapter.destroy).toHaveBeenCalledTimes(2);
    const recovered = request('Capacity recovered after destruction.');
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    adapter.pending[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovered).resolves.toMatchObject({ verdict: 'allow' });
    expect(parser).toHaveBeenCalledTimes(1);
    adapter.pending[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(parser).toHaveBeenCalledTimes(1);
  });
});
