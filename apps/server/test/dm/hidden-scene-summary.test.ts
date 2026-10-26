import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import { closeScene } from '../../src/dm/summarize.js';
import { buildLateJoinRecap } from '../../src/dm/lateJoinRecap.js';

const HIDDEN = { id: 'ent_shade_77', name: 'Vexra the Shade' };
const events = [
  { type: 'SceneNote', payload: { summary: 'The party camped by the well.' } },
  {
    type: 'ReactionResolved',
    payload: {
      type: 'ReactionResolved',
      entityId: HIDDEN.id,
      name: HIDDEN.name,
    },
  },
  {
    type: 'SceneNote',
    payload: { summary: `${HIDDEN.name} waits behind the pillar.` },
  },
  {
    type: 'CombatStarted',
    payload: {
      type: 'CombatStarted',
      order: ['pc_1', HIDDEN.id],
      description: 'Ambush',
    },
  },
];
const allow = {
  moderate: async () => ({ verdict: 'allow' }),
} as never;

function capture() {
  const rows: string[] = [];
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO scene_summaries'))
          rows.push(String(params[2]));
        else if (sql.includes('registry')) rows.push(JSON.stringify(params));
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  } as never;
  return { rows, db };
}
/** Echoes its whole prompt, so any hidden data given to the LLM appears in the stored summary. */
const echo = (extra = ''): LlmAdapter =>
  ({
    capabilities: () => ({}),
    probe: async () => true,
    complete: async function* (req: {
      messages: { content: string }[];
    }): AsyncIterable<LlmChunk> {
      yield {
        type: 'text',
        delta: JSON.stringify({
          summary: req.messages.map((m) => m.content).join(' ') + extra,
          registryDiffs: [],
        }),
      };
    },
  }) as never;
const run = (adapter: LlmAdapter, db: never) =>
  closeScene({
    sessionId: 's',
    sceneId: 'sc',
    events,
    db,
    adapter,
    moderator: allow,
    tier: 'standard',
    tableLines: [],
    hidden: [HIDDEN],
  });
const leaks = (text: string) => /ent_shade_77|Vexra/i.test(text);

describe('scene close uses the public view (ADR-034 §3)', () => {
  it('does not send hidden-entity events to the LLM or store them', async () => {
    const { rows, db } = capture();
    await run(echo(), db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(leaks)).toBe(false);
    expect(rows.join(' ')).toContain('camped by the well');
  });

  it('deterministic fallback omits hidden events', async () => {
    const { rows, db } = capture();
    await run(
      {
        capabilities: () => ({}),
        probe: async () => true,
        complete: async function* () {
          throw new Error('down');
        },
      } as never,
      db,
    );
    expect(rows.some(leaks)).toBe(false);
  });

  it('scrubs a hidden name the LLM itself produced', async () => {
    const { rows, db } = capture();
    await run(echo(' Vexra the Shade lurks.'), db);
    expect(rows.some(leaks)).toBe(false);
  });

  it('the stored summary a non-seated applicant is served has no hidden id or name', async () => {
    const { rows, db } = capture();
    await run(echo(), db);
    const reader = {
      query: async (sql: string) =>
        sql.includes('FROM scene_summaries')
          ? { rows: [{ text: `Scene sc: ${rows[0]}` }] }
          : { rows: [] },
    } as never;
    const out = await buildLateJoinRecap({
      db: reader,
      sessionId: 's',
      moderator: allow,
      tier: 'standard',
      tableLines: [],
    });
    expect(leaks(out.recap)).toBe(false);
  });
});
