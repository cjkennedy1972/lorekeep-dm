import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { buildPrompt } from '../../src/dm/prompt.js';
import { Room } from '../../src/room/Room.js';
import { RecordedLlmAdapter } from '../../src/llm/recorded.js';
import { Persistence } from '../../src/persistence/index.js';
import {
  upsertLocation,
  upsertNpc,
  type WorldRegistry,
} from '@game/rules-engine/room-tools';
import type { RegistryEvent } from '../../src/dm/memory.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
let database: TestDatabase | undefined;
let memory: RegistryMemory;
const gameA = '00000000-0000-4000-8000-000000002601';
const gameB = '00000000-0000-4000-8000-000000002602';

describe.skipIf(!databaseUrl)('registry memory in Postgres', () => {
  beforeAll(async () => {
    // pg_trgm lives in public (database-wide extension); keep the test schema first so tables stay isolated.
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await database.pool.query(
      `CREATE TABLE sessions (id uuid PRIMARY KEY, owner_account_id uuid, last_active_at timestamptz NOT NULL DEFAULT now());
       CREATE TABLE events (session_id uuid NOT NULL REFERENCES sessions(id), seq bigint NOT NULL, turn_id uuid NOT NULL, type text NOT NULL, payload jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,seq));
       CREATE TABLE snapshots (session_id uuid NOT NULL REFERENCES sessions(id), seq bigint NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,seq))`,
    );
    await database.pool.query('INSERT INTO sessions(id) VALUES ($1)', [gameA]);
    await database.pool.query('INSERT INTO sessions(id) VALUES ($1)', [gameB]);
    const migration = await readFile(
      new URL('../../migrations/0014_registry.sql', import.meta.url),
      'utf8',
    );
    await database.pool.query(migration);
    memory = new RegistryMemory(database.pool);
  }, 30_000);
  afterAll(async () => {
    await database?.pool.query('SELECT purge_session($1)', [
      '00000000-0000-4000-8000-000000002603',
    ]);
    await database?.close();
  });

  it('injects existing NPC facts into the real prompt when a player names its alias', async () => {
    const aliasGame = '00000000-0000-4000-8000-000000002603';
    await database!.pool.query('INSERT INTO sessions(id) VALUES ($1)', [
      aliasGame,
    ]);
    await memory.upsert(aliasGame, {
      kind: 'npc',
      id: 'npc_ferryman',
      aliases: ['the ferryman'],
      after: {
        id: 'npc_ferryman',
        name: 'Mara Vale',
        role: 'boat keeper',
        disposition: 'friendly',
        facts: ['Keeps the east key.'],
      },
    });
    const context = await memory.contextFor(
      aliasGame,
      'Ask the FERRYMAN about the crossing.',
      '',
    );
    const prompt = buildPrompt({
      catalogVersion: 'test',
      toolMode: 'native',
      sceneId: 'test-scene',
      settingsHash: 'test',
      session: {
        contentTier: 'standard',
        safetySettings: {},
        partyRoster: [],
        premise: 'Test',
        sceneSummary: 'Test',
      },
      activeMode: 'exploration',
      turn: {
        state: { characters: [] },
        playerText: 'Ask the FERRYMAN about the crossing.',
        registryFacts: context.registryFacts,
        retrievedMemory: context.retrievedMemory,
      },
    });
    expect(context.registryFacts).toContainEqual(
      expect.objectContaining({
        entityId: 'npc_ferryman',
        text: 'Keeps the east key.',
      }),
    );
    expect(prompt.blocks[2]).toContain(
      Buffer.from('Keeps the east key.').toString('base64'),
    );
  });

  it('persists 20 tool-executor facts through three fresh Room sessions and replays consistent memory', async () => {
    const sessionId = randomUUID();
    const accountId = randomUUID();
    await database!.pool.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Replay',true,now(),'v1',now())`,
      [accountId, `${accountId}@example.test`],
    );
    await database!.pool.query(
      'INSERT INTO sessions(id,owner_account_id) VALUES ($1,$2)',
      [sessionId, accountId],
    );
    const persistence = new Persistence(database!.pool);
    const lease = {
      sessionId,
      nodeId: 'fixture',
      epoch: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const world: WorldRegistry = {
      npcs: {},
      locations: {},
      quests: {},
      flags: {},
      rulings: [],
    };
    const fixtureDir = await mkdtemp(join(tmpdir(), 'us-e3-recorded-'));
    const fixturePath = join(fixtureDir, 'session.ndjson');
    const expected = [
      ...Array.from({ length: 10 }, (_, i) => `NPC ${i} guards landmark ${i}.`),
      ...Array.from(
        { length: 10 },
        (_, i) => `Place ${i} contains marker ${i}.`,
      ),
    ].sort();
    let room = new Room(
      persistence,
      lease,
      await persistence.loadLatest(sessionId),
      {
        async run(request) {
          const events: RegistryEvent[] = [];
          const contextBeforePrompt = await memory.contextFor(
            sessionId,
            request.text,
            '',
          );
          const replayPrompt = buildPrompt({
            catalogVersion: 'fixture',
            toolMode: 'native',
            sceneId: 'scene',
            settingsHash: 'fixed',
            session: {
              contentTier: 'standard',
              safetySettings: {},
              partyRoster: [],
              premise: 'US-E3',
              sceneSummary: 'Fixed scene',
            },
            activeMode: 'exploration',
            turn: {
              state: { characters: [] },
              playerText: request.text,
              registryFacts: contextBeforePrompt.registryFacts,
              retrievedMemory: contextBeforePrompt.retrievedMemory,
            },
          });
          const adapter = new RecordedLlmAdapter({
            mode: request.text.includes('establish') ? 'record' : 'strict',
            fixturePath,
            header: {
              suite: 'US-E3',
              turn: request.actionId,
              turnSeed: '0x0000000000000000',
            },
            upstream: request.text.includes('establish')
              ? {
                  capabilities: () => ({
                    streaming: true,
                    nativeTools: true,
                    jsonSchema: true,
                  }),
                  async probe() {
                    return true;
                  },
                  async *complete() {
                    yield {
                      type: 'text' as const,
                      delta: 'Recorded session response.',
                    };
                  },
                }
              : undefined,
            prefix: 'US-E3 fixed-seed',
            dynamic: () => replayPrompt.messages,
            allowRecord: true,
            environment: 'test',
          });
          for await (const chunk of adapter.complete({
            messages: [{ role: 'user', content: request.text }],
            maxTokens: 32,
          })) {
            expect(chunk).toEqual({
              type: 'text',
              delta: 'Recorded session response.',
            });
          }
          if (request.text.includes('establish')) {
            for (let i = 0; i < 10; i++) {
              const npc = upsertNpc(world, {
                id: `npc_person_${i}`,
                name: `Person ${i}`,
                role: 'keeper',
                disposition: 'friendly',
                facts: [`NPC ${i} guards landmark ${i}.`],
              });
              if (npc.ok) events.push(...npc.events);
              const place = upsertLocation(world, {
                id: `loc_place_${i}`,
                name: `Place ${i}`,
                role: 'landmark',
                facts: [`Place ${i} contains marker ${i}.`],
              });
              if (place.ok) events.push(...place.events);
            }
          } else {
            const mentioned = await memory.contextFor(
              sessionId,
              request.text,
              '',
            );
            expect(mentioned.registryFacts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  entityId: 'npc_person_0',
                  text: 'NPC 0 guards landmark 0.',
                }),
                expect.objectContaining({
                  entityId: 'loc_place_0',
                  text: 'Place 0 contains marker 0.',
                }),
              ]),
            );
            if (request.text.includes('contradict')) {
              expect(
                upsertNpc(world, {
                  id: 'npc_person_0',
                  name: 'Person 0',
                  role: 'keeper',
                  disposition: 'friendly',
                  facts: ['NPC 0 guards a different landmark.'],
                }),
              ).toMatchObject({ ok: false, error: 'fact-immutable' });
              expect(
                upsertLocation(world, {
                  id: 'loc_place_0',
                  name: 'Place 0',
                  role: 'landmark',
                  facts: ['Place 0 contains a different marker.'],
                }),
              ).toMatchObject({ ok: false, error: 'fact-immutable' });
            }
          }
          return {
            narration: 'Facts remain established.',
            events: [
              { type: 'TurnStarted', turnId: request.actionId },
              ...events,
            ],
            state: { world },
            turnSeed: '0x0000000000000000',
            usage: { in: 1, out: 1 },
          };
        },
      },
    );
    try {
      await room.seat(accountId, 'Player');
      for (const [index, text] of [
        'establish all NPC and place facts',
        'alias Person 0 and Place 0; contradict both without supersession',
        'after restart recall Person 0 and Place 0',
      ].entries()) {
        if (index > 0) {
          const latest = await persistence.loadLatest(sessionId);
          room = new Room(persistence, lease, latest, {
            async run(request) {
              const adapter = new RecordedLlmAdapter({
                mode: 'strict',
                fixturePath,
                prefix: 'US-E3 fixed-seed',
                dynamic: () => replayPrompt.messages,
              });
              for await (const chunk of adapter.complete({
                messages: [{ role: 'user', content: request.text }],
                maxTokens: 32,
              }))
                expect(chunk).toEqual({
                  type: 'text',
                  delta: 'Recorded session response.',
                });
              expect(context.registryFacts).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    entityId: 'npc_person_0',
                    text: 'NPC 0 guards landmark 0.',
                  }),
                  expect.objectContaining({
                    entityId: 'loc_place_0',
                    text: 'Place 0 contains marker 0.',
                  }),
                ]),
              );
              if (request.text.includes('contradict')) {
                expect(
                  upsertNpc(world, {
                    id: 'npc_person_0',
                    name: 'Person 0',
                    role: 'keeper',
                    disposition: 'friendly',
                    facts: ['NPC 0 guards a different landmark.'],
                  }),
                ).toMatchObject({ ok: false, error: 'fact-immutable' });
                expect(
                  upsertLocation(world, {
                    id: 'loc_place_0',
                    name: 'Place 0',
                    role: 'landmark',
                    facts: ['Place 0 contains a different marker.'],
                  }),
                ).toMatchObject({ ok: false, error: 'fact-immutable' });
              }
              return {
                narration: 'The recorded response is consistent.',
                events: [{ type: 'TurnStarted', turnId: request.actionId }],
                state: request.state,
                turnSeed: '0x0000000000000000',
                usage: { in: 1, out: 1 },
              };
            },
          });
        }
        const actionId = `00000000-0000-4000-8000-0000000026${String(index + 10).padStart(2, '0')}`;
        const completion = new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            void persistence.loadLatest(sessionId).then((latest) => {
              if (
                (latest.snapshot?.seq ?? 0) > 0 &&
                latest.snapshot?.state &&
                JSON.stringify(latest.snapshot.state).includes(actionId)
              ) {
                clearInterval(timer);
                resolve();
              }
            });
          }, 10);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 2000);
        });
        await room.submitAction(accountId, actionId, text, 'Player');
        await completion;
      }
      const persisted = await memory.entities(sessionId);
      expect(persisted).toHaveLength(20);
      expect(persisted.flatMap((entity) => entity.facts).sort()).toEqual(
        expected,
      );
      const committedRegistryEvents = await database!.pool.query<{ n: number }>(
        "SELECT count(*)::int n FROM events WHERE session_id=$1 AND type IN ('NpcUpserted','LocationUpserted')",
        [sessionId],
      );
      expect(committedRegistryEvents.rows[0]!.n).toBe(20);
    } finally {
      await database!.pool.query('SELECT purge_session($1)', [sessionId]);
      await database!.pool.query('DELETE FROM accounts WHERE id=$1', [
        accountId,
      ]);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('upserts with supersession history, isolates sessions, ranks and bounds retrieval deterministically', async () => {
    await memory.upsert(gameA, {
      kind: 'npc',
      id: 'npc_lyra',
      aliases: ['Moon Weaver'],
      after: {
        id: 'npc_lyra',
        name: 'Lyra Vale',
        role: 'archivist',
        disposition: 'friendly',
        facts: ['Guards the silver archive.'],
      },
    });
    await memory.upsert(gameA, {
      kind: 'npc',
      id: 'npc_lyra',
      aliases: ['Moon Weaver'],
      supersedesFacts: {
        'Guards the silver archive.': 'Now trusts the party.',
      },
      after: {
        id: 'npc_lyra',
        name: 'Lyra Vale',
        role: 'archivist',
        disposition: 'friendly',
        facts: ['Guards the silver archive.', 'Now trusts the party.'],
      },
    });
    await memory.upsert(gameB, {
      kind: 'npc',
      id: 'npc_lyra',
      after: {
        id: 'npc_lyra',
        name: 'Lyra Vale',
        role: 'stranger',
        disposition: 'unfriendly',
        facts: ['Has a different secret history.'],
      },
    });
    const history = await database!.pool.query(
      'SELECT id, version, supersedes_id, superseded_by FROM registry_entries WHERE session_id=$1 ORDER BY version',
      [gameA],
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[1].supersedes_id).toBe(history.rows[0].id);
    expect(history.rows[0].superseded_by).toBe(history.rows[1].id);
    const facts = await database!.pool.query(
      `SELECT f.id, f.fact, f.supersedes_id, f.superseded_by FROM registry_facts f JOIN registry_entries e ON e.id=f.entry_id WHERE e.session_id = ANY($1::uuid[]) ORDER BY f.id`,
      [[gameA, gameB]],
    );
    // v1 holds the original fact; v2 carries it forward and adds the replacement;
    // game B has its own unrelated fact.
    expect(facts.rows.map((row) => row.fact)).toEqual([
      'Guards the silver archive.',
      'Guards the silver archive.',
      'Now trusts the party.',
      'Has a different secret history.',
    ]);
    // The replacement supersedes the live (v2) copy, which continues the v1 original:
    // the whole history can be walked back to the first version.
    expect(facts.rows[1].supersedes_id).toBe(facts.rows[0].id);
    expect(facts.rows[1].superseded_by).toBe(facts.rows[2].id);
    expect(facts.rows[2].supersedes_id).toBe(facts.rows[1].id);
    expect(facts.rows[2].superseded_by).toBeNull();
    // The only current fact for game A is the replacement.
    const currentFacts = await database!.pool.query(
      `SELECT f.fact FROM registry_facts f JOIN registry_entries e ON e.id = f.entry_id
        WHERE e.session_id = $1 AND e.superseded_by IS NULL AND f.superseded_by IS NULL`,
      [gameA],
    );
    expect(currentFacts.rows.map((row) => row.fact)).toEqual([
      'Now trusts the party.',
    ]);
    expect(
      await memory.mentionedFacts(
        gameA,
        'The Moon Weaver knows about the silver archive',
        '',
      ),
    ).toEqual([
      {
        entityId: 'npc_lyra',
        text: 'Now trusts the party.',
        mentionedAt: expect.any(Number),
      },
    ]);
    expect(await memory.mentionedFacts(gameB, 'silver archive', '')).toEqual(
      [],
    );
    const results = await memory.retrieve(gameA, 'now trusts the party', 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('Now trusts the party.');
    expect(await memory.retrieve(gameA, 'silver archive', 100)).toEqual([]);
    expect(await memory.retrieve(gameA, 'now trusts the party', 1)).toEqual(
      results,
    );
    await expect(
      memory.upsert(gameA, {
        kind: 'npc',
        id: 'npc_secret',
        after: {
          id: 'npc_secret',
          name: 'Secret Holder',
          role: 'stranger',
          disposition: 'neutral',
          facts: [],
          apiKey: 'never-persist',
        },
      }),
    ).rejects.toThrow();

    const fixtures = [
      ['amber observatory', 'Tracks the amber comet.'],
      ['copper orchard', 'The copper apples restore one vigor.'],
      ['silent bell tower', 'Its bell rings beneath the lake.'],
      ['frosted causeway', 'Ice hides the northern crossing.'],
      ['glass gardens', 'Blue roses grow under glass.'],
      ['ashen library', 'The third shelf contains a map.'],
      ['whispering mill', 'The mill answers questions at dusk.'],
      ['basalt shrine', 'Offerings are left for the river saint.'],
      ['sunken foundry', 'The forge is still warm.'],
      ['redwood observatory', 'A telescope points toward the western star.'],
    ] as const;
    for (const [index, [name, fact]] of fixtures.entries()) {
      await memory.upsert(gameA, {
        kind: 'location',
        id: `loc_fixture_${index}`,
        after: {
          id: `loc_fixture_${index}`,
          name,
          role: 'place',
          facts: [fact],
        },
      });
    }
    for (const [name, fact] of fixtures) {
      const found = await memory.retrieve(gameA, fact, 3);
      expect(found.some((item) => item.includes(name))).toBe(true);
    }
  });
});
