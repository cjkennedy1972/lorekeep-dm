import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegistryMemory } from '../../src/dm/memory.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const databaseUrl = process.env.DATABASE_URL;
let database: TestDatabase | undefined;
let memory: RegistryMemory;
const gameA = '00000000-0000-4000-8000-000000000001';
const gameB = '00000000-0000-4000-8000-000000000002';

describe.skipIf(!databaseUrl)('registry memory in Postgres', () => {
  beforeAll(async () => {
    // pg_trgm lives in public (database-wide extension); keep the test schema first so tables stay isolated.
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await database.pool.query('CREATE TABLE sessions (id uuid PRIMARY KEY)');
    await database.pool.query('INSERT INTO sessions(id) VALUES ($1)', [gameA]);
    await database.pool.query('INSERT INTO sessions(id) VALUES ($1)', [gameB]);
    const migration = await readFile(
      new URL('../../migrations/0014_registry.sql', import.meta.url),
      'utf8',
    );
    await database.pool.query(migration);
    memory = new RegistryMemory(database.pool);
  }, 30_000);
  afterAll(async () => database?.close());

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
      'SELECT id, fact, supersedes_id, superseded_by FROM registry_facts ORDER BY id',
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
