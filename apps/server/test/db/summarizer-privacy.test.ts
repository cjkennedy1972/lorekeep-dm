import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeScene, projectSummarizerEvents } from '../../src/dm/summarize.js';
import { RegistryMemory } from '../../src/dm/memory.js';
import { Persistence } from '../../src/persistence/index.js';
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
    await db.pool.query(
      'CREATE TABLE session_lease(session_id uuid PRIMARY KEY,node_id text NOT NULL,expires_at timestamptz NOT NULL,epoch bigint NOT NULL)',
    );
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
      `INSERT INTO session_seat_characters(session_id,account_id,seat_id,character_id,binding_status,character_snapshot) VALUES($1,$2,$3,$4,'active',$5)`,
      [
        sessionId,
        accountId,
        seatId,
        characterId,
        JSON.stringify({ id: characterId, name: displayName }),
      ],
    );
    for (const file of [
      '0014_registry.sql',
      '0015_scene_summary_idempotency.sql',
      '0030_scene_summary_turn_link.sql',
      '0031_registry_turn_link.sql',
      '0045_derived_memory_character_refs.sql',
      '0046_derived_memory_hold_serialization.sql',
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

  it('preserves validated combat recap facts while removing opaque IDs before the prompt', async () => {
    const start = requests.length;
    const events = [
      {
        type: 'CombatStarted',
        payload: {
          combatId: 'combat-private-42',
          entityIds: ['ent_foreign'],
          order: ['ent_foreign'],
        },
      },
      {
        type: 'MoveStarted',
        payload: {
          entityId: 'ent_foreign',
          path: [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
          ],
          turnId: 'turn_private',
        },
      },
      {
        type: 'ReactionAnswered',
        payload: { promptId: 'rp_734', choice: 'decline' },
      },
      {
        type: 'TurnResolved',
        payload: {
          turnId: 'turn_private',
          entityId: 'ent_foreign',
          eventIds: ['88731'],
        },
      },
      {
        type: 'HpChanged',
        payload: { entityId: 'ent_foreign', delta: -4, hp: 5 },
      },
      {
        type: 'MoveEnded',
        payload: {
          entityId: 'ent_foreign',
          turnId: 'turn_private',
          reason: 'complete',
        },
      },
      { type: 'CombatEnded', payload: { combatId: 'combat-private-42' } },
    ];
    expect(projectSummarizerEvents(events)).toHaveLength(7);
    await closeScene({
      sessionId,
      sceneId: 'scene-combat-recap',
      events,
      adapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    const prompt = requests.slice(start).join('\n');
    for (const fact of [
      'CombatStarted',
      'MoveStarted',
      'ReactionAnswered',
      'decline',
      'TurnResolved',
      'HpChanged',
      '-4',
      'MoveEnded',
      'CombatEnded',
    ])
      expect(prompt).toContain(fact);
    for (const id of [
      'combat-private-42',
      'turn_private',
      'rp_734',
      '88731',
      'ent_foreign',
    ])
      expect(prompt).not.toContain(id);
  });

  it('tokenizes plural and possessive identity variants on registry writes', async () => {
    const registry = new RegistryMemory(db.pool);
    await registry.upsertMany(sessionId, [
      {
        kind: 'npc',
        id: 'npc_plural_identity',
        after: {
          id: 'npc_plural_identity',
          name: 'The Harpers',
          role: 'guild',
          disposition: 'neutral',
          facts: [
            'The Harpers hold the mill deed.',
            "Harper's seal marks the deed.",
          ],
        },
      },
    ]);
    const rows = await db.pool.query(
      "SELECT name, payload::text AS payload, search_document FROM registry_entries WHERE session_id=$1 AND entity_id='npc_plural_identity'",
      [sessionId],
    );
    expect(rows.rowCount).toBe(1);
    expect(JSON.stringify(rows.rows)).not.toMatch(/Harpers|Harper's/);
  });

  it('blocks Joneses variants on registry writes', async () => {
    const unboundAccountId = randomUUID();
    await db.pool.query('INSERT INTO accounts VALUES($1,$2,$3)', [
      unboundAccountId,
      'Jones',
      'jones@example.test',
    ]);
    await db.pool.query(
      `INSERT INTO session_seat_characters(session_id,account_id,seat_id,character_id,binding_status,character_snapshot) VALUES($1,$2,$3,$4,'active',$5)`,
      [
        sessionId,
        unboundAccountId,
        randomUUID(),
        randomUUID(),
        JSON.stringify({ name: 'Jones' }),
      ],
    );
    const registry = new RegistryMemory(db.pool);
    await registry.upsertMany(sessionId, [
      {
        kind: 'npc',
        id: 'npc_group',
        after: {
          id: 'npc_group',
          name: 'Neighbors',
          role: 'group',
          disposition: 'neutral',
          facts: [
            'The Joneses gathered at the mill.',
            "Joneses' deed is at the inn.",
            'Joneses’ seal marks the box.',
          ],
        },
      },
    ]);
    const rows = await db.pool.query<{ payload: string }>(
      "SELECT payload::text AS payload FROM registry_entries WHERE session_id=$1 AND entity_id='npc_group'",
      [sessionId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.payload).not.toMatch(/Joneses['’]?/);
  });

  it('rejects registry persistence when an upserted fact contains player identity and quoted player text', async () => {
    const registry = new RegistryMemory(db.pool);
    await expect(
      registry.upsertMany(
        sessionId,
        [
          {
            kind: 'npc',
            id: 'npc_privacy_gate',
            after: {
              id: 'npc_privacy_gate',
              name: 'Guide',
              role: 'traveler',
              disposition: 'neutral',
              facts: [`Will Harper said: ${quotedText}`],
            },
          },
        ],
        { forbiddenPlayerText: [quotedText] },
      ),
    ).rejects.toThrow(/player text|privacy/i);
    await expect(
      registry.upsert(
        sessionId,
        {
          kind: 'npc',
          id: 'npc_privacy_upsert',
          after: {
            id: 'npc_privacy_upsert',
            name: 'Guide',
            role: 'traveler',
            disposition: 'neutral',
            facts: [`Will Harper said: ${quotedText}`],
          },
        },
        { forbiddenPlayerText: [quotedText] },
      ),
    ).rejects.toThrow(/player text|privacy/i);
    await expect(
      new Persistence(db.pool).persistRegistryEvents(
        sessionId,
        [
          {
            type: 'NpcUpserted',
            npc: {
              id: 'npc_privacy_event',
              name: 'Guide',
              role: 'traveler',
              disposition: 'neutral',
              facts: [`Will Harper said: ${quotedText}`],
            },
          },
        ],
        undefined,
        { forbiddenPlayerText: [quotedText] },
      ),
    ).rejects.toThrow(/player text|privacy/i);
    const persisted = await db.pool.query(
      `SELECT e.name,e.payload::text AS payload,e.search_document,f.fact
         FROM registry_entries e LEFT JOIN registry_facts f ON f.entry_id=e.id
        WHERE e.session_id=$1 AND e.entity_id IN ('npc_privacy_gate','npc_privacy_upsert','npc_privacy_event')`,
      [sessionId],
    );
    expect(persisted.rows).toEqual([]);

    await expect(
      registry.closeScene(
        sessionId,
        'scene_registry_quote_gate',
        `Will Harper said: ${quotedText}`,
        [],
        null,
        { forbiddenPlayerText: [quotedText] },
      ),
    ).rejects.toThrow(/player text|privacy/i);
    await registry.upsertMany(sessionId, [
      {
        kind: 'npc',
        id: 'npc_privacy_tokenized',
        after: {
          id: 'npc_privacy_tokenized',
          name: 'Guide',
          role: 'traveler',
          disposition: 'neutral',
          facts: ["Wills’ map guides Will's route past Will Harper."],
        },
      },
    ]);
    const token = (
      await db.pool.query(
        'SELECT token FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
        [sessionId, characterId],
      )
    ).rows[0]?.token as string;
    const safeEntry = await db.pool.query<{ fact: string; refs: number }>(
      `SELECT f.fact,(SELECT count(*)::int FROM derived_memory_character_refs r WHERE r.row_kind='registry_entry' AND r.row_id=e.id) AS refs
         FROM registry_entries e JOIN registry_facts f ON f.entry_id=e.id
        WHERE e.session_id=$1 AND e.entity_id='npc_privacy_tokenized'`,
      [sessionId],
    );
    expect(safeEntry.rows[0]?.fact).toContain(token);
    expect(safeEntry.rows[0]?.fact).not.toMatch(/Will/i);
    expect(safeEntry.rows[0]?.refs).toBe(1);
  });

  it('refuses to close a held session with no active character binding', async () => {
    const heldSession = randomUUID();
    await db.pool.query('INSERT INTO sessions(id) VALUES($1)', [heldSession]);
    await db.pool.query(
      "INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)",
      [heldSession],
    );
    const holdAdapter: LlmAdapter = {
      ...adapter,
      async *complete() {
        yield {
          type: 'text',
          delta: JSON.stringify({ summary: 'Closed.', registryDiffs: [] }),
        };
      },
    } as unknown as LlmAdapter;
    await expect(
      closeScene({
        sessionId: heldSession,
        sceneId: 'scene-held-no-binding',
        events: [],
        adapter: holdAdapter,
        db: db.pool,
        moderator,
        tier: 'standard',
        tableLines: [],
      }),
    ).rejects.toThrow(/held/i);
    expect(
      (
        await db.pool.query(
          'SELECT 1 FROM scene_summaries WHERE session_id=$1',
          [heldSession],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('merges caller-supplied player text into the closeScene echo guard', async () => {
    const prompts: string[] = [];
    let call = 0;
    const echoAdapter: LlmAdapter = {
      ...adapter,
      async *complete(req: { messages: { content: string }[] }) {
        prompts.push(req.messages.map((message) => message.content).join('\n'));
        call += 1;
        yield {
          type: 'text',
          delta: JSON.stringify({
            summary: call === 1 ? quotedText : 'The combat ended.',
            registryDiffs: [],
          }),
        };
      },
    } as unknown as LlmAdapter;
    const out = await closeScene({
      sessionId,
      sceneId: 'scene-caller-player-text',
      events: [],
      forbiddenPlayerText: [quotedText],
      adapter: echoAdapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    expect(call).toBe(2);
    expect(prompts.join('\n')).not.toContain(quotedText);
    expect(out.summary).toBe('The combat ended.');
  });

  it('serializes closeScene against a session hold inserted after its initial check', async () => {
    const heldSession = randomUUID();
    await db.pool.query('INSERT INTO sessions(id) VALUES($1)', [heldSession]);
    const holdWriter = await db.pool.connect();
    await holdWriter.query('BEGIN');
    try {
      await holdWriter.query(
        "INSERT INTO legal_holds(kind,item_id) VALUES('session',$1)",
        [heldSession],
      );
      const holdAdapter: LlmAdapter = {
        ...adapter,
        async *complete() {
          yield {
            type: 'text',
            delta: JSON.stringify({ summary: 'Closed.', registryDiffs: [] }),
          };
        },
      } as unknown as LlmAdapter;
      const closing = closeScene({
        sessionId: heldSession,
        sceneId: 'scene-held-race',
        events: [],
        adapter: holdAdapter,
        db: db.pool,
        moderator,
        tier: 'standard',
        tableLines: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        (
          await db.pool.query(
            'SELECT 1 FROM scene_summaries WHERE session_id=$1',
            [heldSession],
          )
        ).rowCount,
      ).toBe(0);
      await holdWriter.query('COMMIT');
      await expect(closing).rejects.toThrow(/held/i);
      expect(
        (
          await db.pool.query(
            'SELECT 1 FROM scene_summaries WHERE session_id=$1',
            [heldSession],
          )
        ).rowCount,
      ).toBe(0);
    } catch (error) {
      await holdWriter.query('ROLLBACK');
      throw error;
    } finally {
      holdWriter.release();
    }
  });

  it('drops a seat entity id unless it resolves to an active binding in this session', async () => {
    const foreignSeatId = randomUUID();
    const prompts: string[] = [];
    const seatAdapter: LlmAdapter = {
      ...adapter,
      async *complete(req: { messages: { content: string }[] }) {
        prompts.push(req.messages.map((message) => message.content).join('\n'));
        yield {
          type: 'text',
          delta: JSON.stringify({
            summary: 'The turn passed.',
            registryDiffs: [],
          }),
        };
      },
    } as unknown as LlmAdapter;
    await closeScene({
      sessionId,
      sceneId: 'scene-foreign-seat-id',
      events: [
        {
          type: 'InitiativeRolled',
          payload: { entityId: `ent_seat_${foreignSeatId}`, total: 10 },
        },
      ],
      adapter: seatAdapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    expect(prompts.join('\n')).not.toContain(`ent_seat_${foreignSeatId}`);
    const foreignTurnId = randomUUID();
    await closeScene({
      db: db.pool,
      sessionId,
      sceneId: 'scene-foreign-turn-id',
      events: [
        {
          type: 'TurnOpened',
          payload: {
            turnId: foreignTurnId,
            entityId: `ent_seat_${foreignSeatId}`,
            deadline: 10,
          },
        },
      ],
      adapter: seatAdapter,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    expect(prompts.join('\n')).not.toContain(foreignTurnId);
    await closeScene({
      sessionId,
      sceneId: 'scene-bound-seat-id',
      events: [
        {
          type: 'InitiativeRolled',
          payload: { entityId: `ent_seat_${seatId}`, total: 12 },
        },
      ],
      adapter: seatAdapter,
      db: db.pool,
      moderator,
      tier: 'standard',
      tableLines: [],
    });
    const mappedToken = (
      await db.pool.query(
        'SELECT token FROM session_character_tokens WHERE session_id=$1 AND character_id=$2',
        [sessionId, characterId],
      )
    ).rows[0]?.token as string;
    expect(prompts.join('\n')).not.toContain(`ent_seat_${seatId}`);
    expect(prompts.join('\n')).toContain(mappedToken);
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
