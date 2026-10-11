import { describe, expect, it } from 'vitest';
import {
  createInputGate,
  createModerationJudge,
  type InputGateDb,
} from '../../src/safety/inputGate.js';
import {
  failClosedVerdict,
  type Moderator,
  type ModerationRequest,
  type Verdict,
} from '../../src/safety/moderator.js';

const allowVerdict = (latencyMs = 0): Verdict => ({
  verdict: 'allow',
  category: 'none',
  source: 'judge',
  latencyMs,
  unavailable: false,
});

const blockVerdict = (category: Verdict['category']): Verdict => ({
  verdict: 'block',
  category,
  source: 'judge',
  latencyMs: 0,
  unavailable: false,
});

function fakeDb() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db: InputGateDb = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 } as never;
    },
  };
  return { db, queries };
}

function stubModerator(verdict: Verdict | (() => Verdict)) {
  const calls: ModerationRequest[] = [];
  const moderator: Moderator = {
    async moderate(req) {
      calls.push(req);
      return typeof verdict === 'function' ? verdict() : verdict;
    },
  };
  return { moderator, calls };
}

const recordingLog = () => {
  const warnings: { obj: object; msg: string }[] = [];
  return {
    warnings,
    log: { warn: (obj: object, msg: string) => warnings.push({ obj, msg }) },
  };
};

const innocent = 'The innkeeper pours ale and nods at the table.';
const minorSexual = 'the 14yo girl had sex with the guard';

describe('createInputGate', () => {
  it('allows text the judge allows and writes no log row', async () => {
    const { db, queries } = fakeDb();
    const { moderator, calls } = stubModerator(allowVerdict());
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    expect(
      await gate.check({
        text: innocent,
        surface: 'player-action',
        accountId: 'a1',
      }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      text: innocent,
      direction: 'input',
      tier: 'family',
    });
    expect(queries).toHaveLength(0);
  });

  it('hard floor blocks before the judge is called and logs the row', async () => {
    const { db, queries } = fakeDb();
    const { moderator, calls } = stubModerator(allowVerdict());
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    expect(
      await gate.check({
        text: minorSexual,
        surface: 'player-action',
        accountId: 'a1',
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual(
      expect.arrayContaining([
        'player-action',
        'a1',
        'minor_sexual',
        'hardfloor',
      ]),
    );
  });

  it('judge block rejects and records the category', async () => {
    const { db, queries } = fakeDb();
    const { moderator } = stubModerator(blockVerdict('violence'));
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    expect(await gate.check({ text: innocent, surface: 'character' })).toBe(
      false,
    );
    expect(queries[0].params).toEqual(
      expect.arrayContaining(['character', 'violence', 'judge']),
    );
  });

  it('judge outage fails closed with the hard-floor row and records failClosedRow', async () => {
    const { db, queries } = fakeDb();
    const { moderator } = stubModerator(() => failClosedVerdict(3));
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    expect(await gate.check({ text: innocent, surface: 'display-name' })).toBe(
      false,
    );
    expect(queries[0].params).toEqual(
      expect.arrayContaining([
        'display-name',
        'other',
        'failclosed',
        'hard-floor',
      ]),
    );
  });

  it('never stores the submitted text in the log row', async () => {
    const { db, queries } = fakeDb();
    const { moderator } = stubModerator(blockVerdict('hate'));
    const gate = createInputGate({ db, moderator, log: recordingLog().log });
    const text = 'a distinctive player sentence that must not be stored';

    await gate.check({ text, surface: 'player-action' });
    expect(JSON.stringify(queries)).not.toContain('distinctive');
    expect(queries[0].sql).not.toMatch(/\btext\b|\bcontent\b|\braw\b/);
  });

  it('still rejects when the log insert fails, and logs no text', async () => {
    const { moderator } = stubModerator(blockVerdict('hate'));
    const db: InputGateDb = {
      async query() {
        throw new Error('connection reset');
      },
    };
    const { log, warnings } = recordingLog();
    const gate = createInputGate({ db, moderator, log });

    expect(await gate.check({ text: innocent, surface: 'room-name' })).toBe(
      false,
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(innocent);
  });

  it('judges names as family tier when no session is given', async () => {
    const { db } = fakeDb();
    const { moderator, calls } = stubModerator(allowVerdict());
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    await gate.check({ text: 'Mira', surface: 'display-name' });
    expect(calls[0].tier).toBe('family');
  });
});

describe('createModerationJudge', () => {
  it('returns a judge verdict within the 0.4 s input budget on the stubbed-endpoint path', async () => {
    const chat = async () => '{"verdict":"allow","category":"none"}';
    const moderator = createModerationJudge({ chat });
    const { db } = fakeDb();
    const gate = createInputGate({ db, moderator, log: recordingLog().log });

    const started = performance.now();
    expect(await gate.check({ text: innocent, surface: 'display-name' })).toBe(
      true,
    );
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('treats an unparseable judge reply as an outage', async () => {
    const moderator = createModerationJudge({
      chat: async () => 'sure, looks fine',
    });
    const verdict = await moderator.moderate({
      text: innocent,
      tier: 'family',
      direction: 'input',
    });
    expect(verdict).toMatchObject({
      verdict: 'block',
      unavailable: true,
      failClosedRow: 'hard-floor',
    });
  });

  it('sends the judge request at temperature 0', async () => {
    let seen: { temperature?: number } | undefined;
    const moderator = createModerationJudge({
      chat: async (req) => {
        seen = req;
        return '{"verdict":"allow","category":"none"}';
      },
    });
    await moderator.moderate({
      text: innocent,
      tier: 'family',
      direction: 'input',
    });
    expect(seen?.temperature).toBe(0);
  });
});
