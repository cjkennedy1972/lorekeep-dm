import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeScene } from '../../src/dm/summarize.js';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import type { Moderator } from '../../src/safety/moderator.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('ADR-039 summarizer privacy boundary', () => {
  let db: TestDatabase;
  const sessionId = randomUUID();
  const accountId = randomUUID();
  const characterId = randomUUID();
  const seatId = randomUUID();
  const displayName = 'Will Harper';
  const quotedText = 'PLAYER_QUOTE_MUST_NOT_LEAVE_SERVER';
  const requests: string[] = [];
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: false,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(req: {
      messages: { content: string }[];
    }): AsyncIterable<LlmChunk> {
      const prompt = req.messages.map((message) => message.content).join('\n');
      requests.push(prompt);
      const token = prompt.match(/[A-Za-z0-9_-]{32}/)?.[0] ?? 'x'.repeat(32);
      yield { type: 'text', delta: response(token) };
    },
  } as unknown as LlmAdapter;
  const moderator: Moderator = {
    moderate: async () => ({
      verdict: 'allow',
      category: 'none',
      source: 'judge',
      latencyMs: 0,
      unavailable: false,
    }),
  };

  beforeAll(async () => {
    db = await createTestDatabase({ extraSearchPath: ['public'] });
    await db.pool.query('CREATE TABLE sessions(id uuid PRIMARY KEY)');
    await db.pool.query('INSERT INTO sessions(id) VALUES($1)', [sessionId]);
    await db.pool.query(
      'CREATE TABLE accounts(id uuid PRIMARY KEY, display_name text NOT NULL, email text NOT NULL)',
    );
    await db.pool.query(
      'CREATE TABLE legal_holds(kind text NOT NULL, item_id text NOT NULL)',
    );
    await db.pool.query(
      `CREATE TABLE session_seat_characters(session_id uuid NOT NULL, account_id uuid NOT NULL, character_id uuid NOT NULL, character_snapshot jsonb NOT NULL, binding_status text NOT NULL, seat_id uuid NOT NULL)`,
    );
    await db.pool.query(`INSERT INTO accounts VALUES($1,$2,$3)`, [
      accountId,
      displayName,
      'will-handle@example.test',
    ]);
    await db.pool.query(
      `INSERT INTO session_seat_characters VALUES($1,$2,$3,$4,'active',$5)`,
      [
        sessionId,
        accountId,
        characterId,
        JSON.stringify({ id: characterId, name: displayName }),
        seatId,
      ],
    );
    for (const file of [
      '0014_registry.sql',
      '0015_scene_summary_idempotency.sql',
      '0030_scene_summary_turn_link.sql',
      '0031_registry_turn_link.sql',
      '0045_derived_memory_character_refs.sql',
    ]) {
      await db.pool.query(
        await readFile(
          new URL(`../../migrations/${file}`, import.meta.url),
          'utf8',
        ),
      );
    }
  }, 30_000);
  afterAll(async () => db?.close());

  it('sends only projected fields and opaque tokens; retries name collisions and indexes summary/registry references', async () => {
    let call = 0;
    adapter.complete = async function* (req: {
      messages: { content: string }[];
    }) {
      const prompt = req.messages.map((message) => message.content).join('\n');
      requests.push(prompt);
      const token = prompt.match(/[A-Za-z0-9_-]{32}/)?.[0] ?? 'x'.repeat(32);
      call += 1;
      yield {
        type: 'text',
        delta:
          call === 1
            ? JSON.stringify({
                summary: quotedText,
                registryDiffs: [],
              })
            : JSON.stringify({
                summary: `The lantern follows ${token}.`,
                registryDiffs: [
                  {
                    kind: 'npc',
                    id: 'npc_keeper',
                    after: {
                      id: 'npc_keeper',
                      name: 'Keeper',
                      role: 'guide',
                      disposition: 'friendly',
                      facts: [`Observed ${token}.`],
                    },
                  },
                ],
              }),
      };
    };
    const out = await closeScene({
      sessionId,
      sceneId: 'scene-privacy',
      events: [
        {
          type: 'InitiativeRolled',
          payload: {
            type: 'InitiativeRolled',
            entityId: characterId,
            total: 14,
          },
        },
        {
          type: 'ConditionApplied',
          payload: {
            entityId: characterId,
            conditionId: 'condition:prone',
            source: quotedText,
          },
        },
        { type: 'PlayerAction', payload: { text: quotedText } },
        { type: 'SeatJoined', payload: { displayName, accountId } },
      ],
      adapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    expect(call).toBe(2);
    expect(requests.join('\n')).not.toContain(displayName);
    expect(requests.join('\n')).not.toContain('will-handle');
    expect(requests.join('\n')).not.toContain(quotedText);
    expect(requests.join('\n')).toContain('InitiativeRolled');
    expect(requests.join('\n')).not.toContain('SeatJoined');
    const token = (
      await db.pool.query(
        'SELECT token FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
        [sessionId, characterId],
      )
    ).rows[0].token as string;
    expect(requests.join('\n')).toContain(token);
    expect(out.summary).toContain(token);
    expect(out.summary).not.toContain(displayName);
    expect(out.summary).not.toContain('unseen presence');
    expect(out.summary).not.toContain(quotedText);
    const stored = await db.pool.query(
      `SELECT s.summary, e.name, e.aliases, e.payload::text AS payload, e.search_document, f.fact
       FROM scene_summaries s
       LEFT JOIN registry_entries e ON e.session_id=s.session_id
       LEFT JOIN registry_facts f ON f.entry_id=e.id
       WHERE s.session_id=$1`,
      [sessionId],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(quotedText);
    const refs = await db.pool.query(
      'SELECT row_kind FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2 ORDER BY row_kind',
      [sessionId, characterId],
    );
    expect(refs.rows.map((row) => row.row_kind)).toEqual([
      'registry_entry',
      'scene_summary',
    ]);
  });

  it('fails closed before any write when the identity inventory cannot be screened', async () => {
    let writes = 0;
    const brokenDb = {
      query: async () => {
        throw new Error('identity inventory unavailable');
      },
      connect: async () => {
        writes += 1;
        throw new Error('must not connect for write');
      },
    } as never;
    await expect(
      closeScene({
        sessionId,
        sceneId: 'scene-uncertain',
        events: [],
        adapter,
        db: brokenDb,
        moderator,
        tier: 'standard',
        tableLines: [],
      }),
    ).rejects.toThrow('identity inventory unavailable');
    expect(writes).toBe(0);
  });

  it('falls back to the projected deterministic summary when retry still contains identity text', async () => {
    adapter.complete = async function* () {
      yield {
        type: 'text',
        delta: JSON.stringify({
          summary: 'Will has arrived.',
          registryDiffs: [],
        }),
      };
    };
    const out = await closeScene({
      sessionId,
      sceneId: 'scene-fallback',
      events: [
        {
          type: 'HpChanged',
          payload: {
            type: 'HpChanged',
            entityId: characterId,
            delta: -1,
            hp: 9,
          },
        },
      ],
      adapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    expect(out.fallback).toBe(true);
    expect(out.summary).not.toContain(displayName);
    expect(out.summary).toContain('HpChanged');
  });
});
