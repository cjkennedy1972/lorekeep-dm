import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { CharacterSchema, AdventureSchema } from '@game/schema';
import { z } from 'zod';
import { quickBuild, validateCharacter } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { catalogFromSnapshot } from '../room/catalogSnapshot.js';
import { loadAdventure } from '@game/rules-engine/adventure-node';
import { adventure01RegistrySeed } from '@game/rules-engine/adventure-node';
import adventure01 from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import { RegistryMemory } from '../dm/memory.js';
import { authenticateRequest } from '../middleware/auth.js';
import { hardFloorBlocked } from '../safety/hardFloorGate.js';
import { buildResumeRecap } from '../dm/recap.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import { MeteredLlmAdapter, PostgresUsageSink } from '../llm/metering.js';
import {
  RecordedLlmAdapter,
  fixtureModeFromEnvironment,
} from '../llm/recorded.js';

const catalog = loadCatalog();
const adventureParsed = AdventureSchema.parse(adventure01);
const fixtureAdventure = loadAdventure(adventureParsed, catalog);
if (fixtureAdventure.ok === false)
  throw new Error(
    `Adventure #1 is invalid: ${fixtureAdventure.errors.map((e) => e.message).join('; ')}`,
  );
const adventureData = fixtureAdventure.adventure;
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  adventureId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default('adventure:01-hollow-under-marrowfell'),
  difficulty: z.enum(['easy', 'moderate', 'hard']).default('moderate'),
  startingLevel: z.number().int().min(1).max(5).default(1),
  character: CharacterSchema.optional(),
  classId: z.string().optional(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gameView = (row: Record<string, unknown>) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  adventureId: row.adventure_id,
  difficulty: row.difficulty,
  startingLevel: row.character && (row.character as { level?: number }).level,
  catalogVersion: row.catalog_version,
  lastActiveAt: row.last_active_at,
  recap: (row.recap as { recap?: string } | null)?.recap ?? '',
  character: row.character,
});
export function registerTableRoutes(
  app: FastifyInstance,
  db: Pool,
  rooms: Pick<import('../room/registry.js').RoomRegistry, 'get'>,
) {
  async function account(
    request: Parameters<typeof authenticateRequest>[1],
    reply: import('fastify').FastifyReply,
  ) {
    const auth = await authenticateRequest(db, request);
    if (!auth) {
      reply
        .code(401)
        .send({ code: 'UNAUTHENTICATED', message: 'Sign in required.' });
      return undefined;
    }
    return auth.account_id;
  }
  app.post('/api/tables', async (request, reply) => {
    const accountId = await account(request, reply);
    if (!accountId) return reply;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message:
          'Check the table, adventure, difficulty and character choices.',
      });
    const body = parsed.data;
    if (
      body.character &&
      hardFloorBlocked(body.character.name, 'character', request.log)
    )
      return reply.code(400).send({
        code: 'CONTENT_REJECTED',
        message: 'That character name cannot be used.',
      });
    if (body.adventureId !== adventureData.id)
      return reply.code(400).send({
        code: 'ADVENTURE_UNAVAILABLE',
        message: 'That adventure is not available yet.',
      });
    let character =
      body.character ??
      quickBuild(catalog, body.classId, 0x28, body.startingLevel).character;
    if (character.level !== body.startingLevel)
      return reply.code(400).send({
        code: 'INVALID_CHARACTER',
        message: 'Starting level does not match the character.',
      });
    character = { ...character, id: randomUUID() };
    const violations = validateCharacter(character, catalog);
    if (violations.length || character.level !== body.startingLevel)
      return reply.code(400).send({
        code: 'INVALID_CHARACTER',
        message:
          'The character is not valid for this catalog or starting level.',
      });
    const id = randomUUID();
    const premise = adventureData.premise;
    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sessions WHERE owner_account_id=$1 AND mode='solo' AND status='active'",
      [accountId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= 20)
      return reply.code(409).send({
        code: 'ROOM_LIMIT',
        message:
          'You have too many active games. Archive one before creating another.',
      });
    await db.query(
      `INSERT INTO catalog_snapshots(catalog_version,entries)
       VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
      [catalog.catalogVersion, JSON.stringify(catalog.entries)],
    );
    await db.query(
      `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,premise,character_id,character)
        VALUES($1,$2,$3,'active','solo',$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        id,
        accountId,
        body.name,
        body.adventureId,
        body.difficulty,
        catalog.catalogVersion,
        premise,
        character.id,
        JSON.stringify(character),
      ],
    );
    try {
      const room = await rooms.get(id);
      const { rows: optOut } = await db.query<{ mature_opt_out: boolean }>(
        'SELECT mature_opt_out FROM accounts WHERE id=$1',
        [accountId],
      );
      await room.seat(
        accountId,
        'Adventurer',
        optOut[0]?.mature_opt_out ?? false,
      );
      await room.persistGameState({
        characters: { [accountId]: character },
        premise,
        sceneId: adventureData.startingSceneId,
        adventureId: adventureData.id,
        catalogVersion: catalog.catalogVersion,
        difficulty: body.difficulty,
        worldSeeded: true,
      });
      await new RegistryMemory(db).upsertMany(id, adventure01RegistrySeed());
    } catch (error) {
      await db.query(
        'DELETE FROM sessions WHERE id=$1 AND owner_account_id=$2',
        [id, accountId],
      );
      throw error;
    }
    const created = (
      await db.query(
        'SELECT id,name,status,adventure_id,difficulty,catalog_version,last_active_at,character FROM sessions WHERE id=$1 AND owner_account_id=$2',
        [id, accountId],
      )
    ).rows[0]!;
    return reply
      .code(201)
      .send({ game: gameView(created), adventureId: adventureData.id });
  });
  app.get('/api/tables', async (request, reply) => {
    const accountId = await account(request, reply);
    if (!accountId) return reply;
    const result = await db.query(
      `SELECT s.id,s.name,s.status,s.adventure_id,s.difficulty,s.catalog_version,s.last_active_at,s.character,snap.state->'recap' AS recap
      FROM sessions s LEFT JOIN LATERAL (SELECT state FROM snapshots WHERE session_id=s.id ORDER BY seq DESC LIMIT 1) snap ON true
      WHERE s.owner_account_id=$1 AND s.mode='solo' ORDER BY s.last_active_at DESC`,
      [accountId],
    );
    return { games: result.rows.map(gameView) };
  });
  app.get<{ Params: { id: string } }>(
    '/api/tables/:id',
    async (request, reply) => {
      const accountId = await account(request, reply);
      if (!accountId) return reply;
      if (!UUID.test(request.params.id))
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      const result = await db.query(
        `SELECT s.id,s.name,s.status,s.adventure_id,s.difficulty,s.catalog_version,pinned_catalog.entries AS catalog_snapshot,s.last_active_at,s.character,s.premise,s.owner_account_id,snap.state,snap.seq
      FROM sessions s LEFT JOIN catalog_snapshots pinned_catalog ON pinned_catalog.catalog_version=s.catalog_version
      LEFT JOIN LATERAL (SELECT state,seq FROM snapshots WHERE session_id=s.id ORDER BY seq DESC LIMIT 1) snap ON true
      WHERE s.id=$1 AND s.owner_account_id=$2 AND s.mode='solo'`,
        [request.params.id, accountId],
      );
      const row = result.rows[0] as
        | (Record<string, unknown> & { state?: Record<string, unknown> })
        | undefined;
      if (!row) {
        const exists = await db.query(
          "SELECT id FROM sessions WHERE id=$1 AND mode='solo'",
          [request.params.id],
        );
        if (exists.rowCount)
          return reply
            .code(403)
            .send({ code: 'FORBIDDEN', message: 'You do not own this game.' });
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      }
      if (row.status === 'archived' || row.status === 'ended')
        return reply.code(409).send({
          code: 'TABLE_CLOSED',
          message: 'This game is archived or ended.',
        });
      const pinnedCatalog =
        row.catalog_version === catalog.catalogVersion
          ? catalog
          : catalogFromSnapshot(
              row.catalog_version as string | null,
              row.catalog_snapshot,
            );
      if (!pinnedCatalog)
        return reply.code(409).send({
          code: 'CATALOG_VERSION_UNAVAILABLE',
          message:
            'This game needs its pinned rules catalog, which is not available on this server.',
        });
      const latestEvents = await db.query<{
        type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT type,payload FROM events WHERE session_id=$1 ORDER BY seq DESC LIMIT 4`,
        [request.params.id],
      );
      const recent = latestEvents.rows.reverse().map((event) => ({
        type: event.type,
        summary:
          typeof event.payload?.summary === 'string'
            ? event.payload.summary
            : undefined,
      }));
      const prior = (row.state?.recap ??
        (row.state?.gameState as Record<string, unknown> | undefined)
          ?.recap) as { recap: string; memoryHash: string } | undefined;
      const endpointSlot = process.env.SOLO_TURN_ENDPOINT_SLOT ?? 'moderate';
      let adapter;
      try {
        const raw = await createConfiguredAdapter(
          db,
          endpointSlot as 'fast' | 'frontier' | 'moderate',
          createEndpointEgress(),
        );
        const mode = fixtureModeFromEnvironment();
        adapter = new MeteredLlmAdapter(
          mode
            ? new RecordedLlmAdapter({
                mode,
                fixturePath:
                  process.env.LLM_FIXTURE_PATH ?? 'fixtures/solo-turn.ndjson',
                upstream: raw,
                allowRecord: process.env.NODE_ENV === 'test',
                environment: process.env.NODE_ENV,
              })
            : raw,
          new PostgresUsageSink(db),
          {
            sessionId: request.params.id,
            turnId: randomUUID(),
            purpose: 'summary',
            modelId: endpointSlot,
          },
        );
      } catch {
        /* deterministic recap remains available offline */
      }
      const recap = await buildResumeRecap({
        db,
        sessionId: request.params.id,
        lastEvents: recent,
        previousSnapshotRecap: prior,
        adapter,
      });
      await db.query(
        "UPDATE sessions SET last_active_at=now(),status='active' WHERE id=$1 AND owner_account_id=$2",
        [request.params.id, accountId],
      );
      const room = await rooms.get(request.params.id);
      await room.persistRecap({
        recap: recap.recap,
        memoryHash: recap.memoryHash,
      });
      return {
        game: {
          ...gameView({ ...row, recap: { recap: recap.recap } }),
          recap: recap.recap,
          state: room.state,
          catalogVersion: row.catalog_version,
        },
      };
    },
  );
}
