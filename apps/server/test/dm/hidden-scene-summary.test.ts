import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import {
  closeScene,
  hiddenMatcher,
  publicSceneEvents,
} from '../../src/dm/summarize.js';
import { buildResumeRecap } from '../../src/dm/recap.js';
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
const prompts: string[] = [];
/** Echoes its whole prompt, so any hidden data given to the LLM appears in the stored summary. */
const echo = (extra = ''): LlmAdapter =>
  ({
    capabilities: () => ({}),
    probe: async () => true,
    complete: async function* (req: {
      messages: { content: string }[];
    }): AsyncIterable<LlmChunk> {
      prompts.push(req.messages.map((m) => m.content).join(' '));
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
        complete: () => {
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

  it('never sends hidden ids or names to the LLM (input-side filter)', async () => {
    prompts.length = 0;
    await run(echo(), capture().db);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some(leaks)).toBe(false);
  });

  it('does not over-redact: short hidden names and substrings keep normal events', () => {
    const kept = publicSceneEvents(
      [
        {
          type: 'SceneNote',
          payload: { summary: 'The rope crashed onto the floor.' },
        },
      ],
      [{ id: 'ent_ash', name: 'Ash' }],
    );
    expect(kept).toHaveLength(1);
    const m = hiddenMatcher([{ id: 'ent_x', name: 'Vexra' }]);
    expect(m.mentions({ summary: 'Vexra hides.' })).toBe(true);
    expect(m.mentions({ summary: 'Vexrastone is a town.' })).toBe(false);
  });

  const preFixRows = {
    query: async (sql: string) => ({
      rows: sql.includes('FROM scene_summaries')
        ? [{ text: 'Scene a: Vexra the Shade waits in the rafters.' }]
        : sql.includes('FROM registry_entries')
          ? [{ text: 'npc Vexra the Shade: waits in the rafters' }]
          : [],
    }),
  } as never;

  it('late-join recap scrubs hidden text from rows written before the filter existed', async () => {
    prompts.length = 0;
    const out = await buildLateJoinRecap({
      db: preFixRows,
      sessionId: 's',
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      adapter: echo(),
      hidden: [HIDDEN],
    });
    expect(prompts.some(leaks)).toBe(false);
    expect(leaks(out.recap)).toBe(false);
  });

  it('seated resume recap scrubs the same rows', async () => {
    prompts.length = 0;
    const out = await buildResumeRecap({
      db: preFixRows,
      sessionId: 's',
      adapter: echo(),
      hidden: [HIDDEN],
    });
    expect(prompts.some(leaks)).toBe(false);
    expect(leaks(out.recap)).toBe(false);
  });

  it('registry upserts naming a hidden entity are recognised for dropping', () => {
    const m = hiddenMatcher([HIDDEN]);
    expect(
      m.mentions({ type: 'NpcUpserted', npc: { id: 'n1', name: HIDDEN.name } }),
    ).toBe(true);
    expect(
      m.mentions({ type: 'NpcUpserted', npc: { id: 'n2', name: 'Warden' } }),
    ).toBe(false);
  });
});
