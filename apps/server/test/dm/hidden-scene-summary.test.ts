import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import {
  closeScene,
  hiddenMatcher,
  publicSceneEvents,
  containsIdentityVariant,
} from '../../src/dm/summarize.js';
import { emptyRoom, reduceRoom } from '../../src/room/reducer.js';
import { concealedEntities } from '../../src/room/eventVisibility.js';
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
        return {
          rows: [],
          rowCount: sql.includes('FROM legal_holds') ? 0 : 1,
        };
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
    leaseEpoch: null,
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
  it('matches bound names with plural and possessive suffixes', () => {
    expect(containsIdentityVariant('Will Harper’s map', ['Will Harper'])).toBe(
      true,
    );
    expect(
      containsIdentityVariant('The party will continue.', ['Will Harper']),
    ).toBe(false);
    expect(
      containsIdentityVariant('The Willows are quiet.', ['Will Harper']),
    ).toBe(false);
  });

  it('keeps ordinary combat event facts when unresolved IDs are stripped', async () => {
    const { rows, db } = capture();
    prompts.length = 0;
    await closeScene({
      sessionId: 's',
      leaseEpoch: null,
      sceneId: 'combat-projection',
      db,
      adapter: echo(),
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      events: [
        {
          type: 'CombatStarted',
          payload: { combatId: 'combat-42', entityIds: ['ent_enemy'] },
        },
        {
          type: 'InitiativeRolled',
          payload: { entityId: 'ent_enemy', total: 17 },
        },
        {
          type: 'EntityMoved',
          payload: { entityId: 'ent_enemy', path: [{ x: 1, y: 2 }], cost: 1 },
        },
        {
          type: 'HpChanged',
          payload: { entityId: 'ent_enemy', delta: -4, hp: 6 },
        },
        {
          type: 'CombatEnded',
          payload: { combatId: 'combat-42', encounterId: 'encounter-4' },
        },
      ],
    });
    const prompt = prompts.join(' ');
    for (const type of [
      'CombatStarted',
      'InitiativeRolled',
      'EntityMoved',
      'HpChanged',
      'CombatEnded',
    ])
      expect(prompt).toContain(type);
    expect(prompt).toContain('"total":17');
    expect(prompt).toContain('"cost":1');
    expect(prompt).toContain('"delta":-4');
    expect(prompt).not.toContain('ent_enemy');
    expect(prompt).not.toContain('combat-42');
    expect(rows.join(' ')).not.toContain('ent_enemy');
  });

  it('builds seated recap from player-visible narration, not a DM-authored close summary', async () => {
    prompts.length = 0;
    const db = {
      query: async (sql: string) =>
        sql.includes("type='NarrationCompleted'")
          ? {
              rows: [
                {
                  narration: 'The party entered the ruined hall.',
                  tier: 'standard',
                },
              ],
            }
          : sql.includes('scene_summaries')
            ? { rows: [{ text: 'The key is under the throne.' }] }
            : sql.includes('registry_entries')
              ? { rows: [{ text: 'npc Secret Keeper: knows the vault code' }] }
              : { rows: [] },
    } as never;
    const out = await buildResumeRecap({ db, sessionId: 's', adapter: echo() });
    expect(prompts.join('\n')).toContain('The party entered the ruined hall.');
    expect(prompts.join('\n')).not.toContain('key is under the throne');
    expect(prompts.join('\n')).not.toContain('Secret Keeper');
    expect(out.recap).not.toContain('key is under the throne');
  });

  it('rebuilds an unmarked legacy snapshot recap from visible narration', async () => {
    prompts.length = 0;
    const db = {
      query: async () => ({
        rows: [
          { narration: 'The party entered the ruined hall.', tier: 'standard' },
        ],
      }),
    } as never;
    const out = await buildResumeRecap({
      db,
      sessionId: 's',
      adapter: echo(),
      previousSnapshotRecap: {
        recap: 'The key is under the throne.',
        memoryHash: createHash('sha256')
          .update(JSON.stringify([['The party entered the ruined hall.'], []]))
          .digest('hex'),
      },
    });
    expect(out.recap).toContain('The party entered the ruined hall.');
    expect(out.recap).not.toContain('key is under the throne');
    expect(out.provenanceVersion).toBe(2);
  });

  it('does not send hidden-entity events to the LLM or store them', async () => {
    const { rows, db } = capture();
    await run(echo(), db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(leaks)).toBe(false);
    // ADR-039 § Implementation plan, step 2: SceneNote is not in the versioned
    // event allowlist, so its summary must not reach the summarizer or storage.
    expect(rows.join(' ')).not.toContain('camped by the well');
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

  it('late-join recap excludes secret registry facts and only gives the echo model shown narration', async () => {
    prompts.length = 0;
    const db = {
      query: async (sql: string) =>
        sql.includes("type='NarrationCompleted'")
          ? {
              rows: [
                {
                  narration: 'The party entered the ruined hall.',
                  tier: 'standard',
                },
              ],
            }
          : sql.includes('registry_entries')
            ? {
                rows: [
                  { text: 'npc Secret Keeper: the key is under the throne' },
                ],
              }
            : { rows: [] },
    } as never;
    const out = await buildLateJoinRecap({
      db,
      sessionId: 's',
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      adapter: echo(),
    });
    expect(prompts.join('\n')).toContain('The party entered the ruined hall.');
    expect(prompts.join('\n')).not.toMatch(/Secret Keeper|under the throne/);
    expect(out.recap).not.toMatch(/Secret Keeper|under the throne/);
  });

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

  it('a goblin hidden in an earlier turn stays out of summary and both recaps after combat teardown', async () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const commit = (gameState: unknown) =>
      ({ type: 'GameStateCommitted', payload: { gameState } }) as never;
    const room = [
      commit({
        combatRoom: {
          entities: [{ id: 'ent_gob', name: 'Gribble', hidden: true }],
        },
      }),
      commit({ sceneId: 'later' }), // killed, combat torn down, no combatRoom
    ].reduce(reduceRoom, emptyRoom(sid));
    const hidden = concealedEntities(room.gameState);
    expect(hidden).toEqual([{ id: 'ent_gob', name: 'Gribble' }]);
    const gob = (text: string) => /ent_gob|Gribble/i.test(text);

    const { rows, db } = capture();
    prompts.length = 0;
    await closeScene({
      sessionId: 's',
      leaseEpoch: null,
      sceneId: 'sc',
      db,
      adapter: echo(' Gribble the goblin ambushed the party.'),
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      hidden,
      events: [
        {
          type: 'SceneNote',
          payload: { summary: 'Gribble the goblin ambushed the party.' },
        },
      ],
    });
    expect(rows.some(gob)).toBe(false);
    expect(prompts.some(gob)).toBe(false);

    const stored = {
      query: async (sql: string) => ({
        rows: sql.includes('FROM scene_summaries')
          ? [{ text: 'Scene a: Gribble the goblin ambushed the party.' }]
          : [],
      }),
    } as never;
    const late = await buildLateJoinRecap({
      db: stored,
      sessionId: 's',
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      hidden,
    });
    const resume = await buildResumeRecap({
      db: stored,
      sessionId: 's',
      hidden,
    });
    expect(gob(late.recap)).toBe(false);
    expect(gob(resume.recap)).toBe(false);
  });
});
