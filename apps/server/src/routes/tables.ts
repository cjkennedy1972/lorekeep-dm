import { createHash, randomUUID } from 'node:crypto';
import { tokenFromCookie } from '../accounts/sessions.js';
import { hashToken } from '../accounts/signup.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { CharacterSchema, AdventureSchema } from '@game/schema';
import { z } from 'zod';
import { quickBuild, validateCharacter } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { BoundedCounter } from '../accounts/throttle.js';
import { catalogFromSnapshot } from '../room/catalogSnapshot.js';
import { loadAdventure } from '@game/rules-engine/adventure-node';
import { adventure01RegistrySeed } from '@game/rules-engine/adventure-node';
import { CREATE_PER_HOUR } from './sessions.js';
import adventure01 from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import { RegistryMemory } from '../dm/memory.js';
import { authenticateRequest } from '../middleware/auth.js';
import { concealedEntities } from '../room/eventVisibility.js';
import {
  buildResumeRecap,
  gateRecap,
  RECAP_PROVENANCE_VERSION,
} from '../dm/recap.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import { MeteredLlmAdapter, PostgresUsageSink } from '../llm/metering.js';
import { liveDmAllowed } from '../llm/liveDmGate.js';
import { createEndpointJudge } from '../safety/inputGate.js';
import { HARD_FLOOR_VERSION } from '../safety/hardFloor.js';
import {
  loadContentTierState,
  loadSeatedContentBoundaries,
} from '../safety/tierLoader.js';
import {
  RecordedLlmAdapter,
  fixtureModeFromEnvironment,
} from '../llm/recorded.js';
import { currentMemberSql } from '../room/membership.js';

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
  character: CharacterSchema.extend({ id: z.string().optional() }).optional(),
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
  liveDmAllowlistOnly: boolean,
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
  const recapModerator = createEndpointJudge(db);
  async function recapSafety(sessionId: string) {
    const [{ tier }, boundaries] = await Promise.all([
      loadContentTierState(db, sessionId, false),
      loadSeatedContentBoundaries(db, sessionId),
    ]);
    return {
      tier,
      tableLines: [
        ...boundaries.lines.map((line) => `line: ${line}`),
        ...boundaries.veils.map((veil) => `veil: ${veil}`),
      ],
    };
  }
  // ponytail: per-process cache, cap 500 entries; move to a shared store if multiple API instances matter.
  // Only non-fallback verdicts are cached; the key includes the moderate endpoint revision and hard-floor version.
  const screenedRecaps = new Map<string, { recap: string; expires: number }>();
  const SCREENED_RECAP_CACHE_MAX = 500;
  const SCREENED_RECAP_TTL_MS = 10 * 60_000;
  async function screenStoredRecap(sessionId: string, recap: string) {
    if (!recap) return '';
    const [{ tier, tableLines }, endpoint] = await Promise.all([
      recapSafety(sessionId),
      db.query<{ revision: string }>(
        "SELECT updated_at::text AS revision FROM operator_endpoints WHERE slot='moderate'",
      ),
    ]);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          sessionId,
          recap,
          tier,
          tableLines,
          endpoint.rows[0]?.revision ?? null,
          HARD_FLOOR_VERSION,
        ]),
      )
      .digest('hex');
    const hit = screenedRecaps.get(key);
    if (hit && hit.expires > Date.now()) return hit.recap;
    const result = await gateRecap(
      { recap, memoryHash: '', cached: true, fallback: false },
      recapModerator,
      tier,
      tableLines,
      sessionId,
    );
    if (!result.fallback) {
      screenedRecaps.set(key, {
        recap: result.recap,
        expires: Date.now() + SCREENED_RECAP_TTL_MS,
      });
      if (screenedRecaps.size > SCREENED_RECAP_CACHE_MAX)
        screenedRecaps.delete(screenedRecaps.keys().next().value!);
    }
    return result.recap;
  }
  const createHits = new BoundedCounter(3_600_000);
  app.post('/api/tables', async (request, reply) => {
    const accountId = await account(request, reply);
    if (!accountId) return reply;
    const authToken = tokenFromCookie(request.headers.cookie);
    const authTokenHash = authToken ? hashToken(authToken) : undefined;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message:
          'Check the table, adventure, difficulty and character choices.',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path
            .map((part, index) =>
              (issue.path[index - 1] === 'abilities' ||
                issue.path[index - 1] === 'slots') &&
              typeof part === 'string'
                ? '*'
                : part,
            )
            .join('.'),
          code: issue.code,
        })),
      });
    const body = parsed.data;
    if (createHits.hit(accountId) > CREATE_PER_HOUR)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'You are creating tables too quickly. Try again later.',
      });
    const characterTexts = body.character
      ? [
          body.character.name,
          ...body.character.conditions.flatMap((condition) =>
            condition.source ? [condition.source] : [],
          ),
        ]
      : [];
    for (const text of characterTexts) {
      const characterDecision = await app.inputGate.check({
        text,
        surface: 'character',
        accountId,
        ip: request.ip,
      });
      if (characterDecision === 'limited')
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again later.',
        });
      if (characterDecision === 'block')
        return reply.code(400).send({
          code: 'CONTENT_REJECTED',
          message: 'That character name cannot be used.',
        });
    }
    const nameDecision = await app.inputGate.check({
      text: body.name,
      surface: 'table-name',
      accountId,
      ip: request.ip,
    });
    if (nameDecision === 'limited')
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      });
    if (nameDecision === 'block')
      return reply.code(400).send({
        code: 'CONTENT_REJECTED',
        message: 'That table name cannot be used.',
      });
    if (body.adventureId !== adventureData.id)
      return reply.code(400).send({
        code: 'ADVENTURE_UNAVAILABLE',
        message: 'That adventure is not available yet.',
      });
    const character = {
      ...(body.character ??
        quickBuild(catalog, body.classId, 0x28, body.startingLevel).character),
      id: randomUUID(),
    };
    if (character.level !== body.startingLevel)
      return reply.code(400).send({
        code: 'INVALID_CHARACTER',
        message: 'Starting level does not match the character.',
      });
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
        authTokenHash,
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
      `SELECT s.id,s.name,s.status,s.adventure_id,s.difficulty,s.catalog_version,s.last_active_at,s.character,snap.state->'gameState'->'recap' AS recap
      FROM sessions s LEFT JOIN LATERAL (SELECT state FROM snapshots WHERE session_id=s.id ORDER BY seq DESC LIMIT 1) snap ON true
      WHERE s.owner_account_id=$1 AND s.mode='solo' ORDER BY s.last_active_at DESC`,
      [accountId],
    );
    const games = await Promise.all(
      result.rows.map(async (row: Record<string, unknown>) => {
        const stored = row.recap as {
          recap?: string;
          provenanceVersion?: number;
        } | null;
        const recap =
          stored?.provenanceVersion === RECAP_PROVENANCE_VERSION
            ? (stored.recap ?? '')
            : '';
        return gameView({
          ...row,
          recap: { recap: await screenStoredRecap(String(row.id), recap) },
        });
      }),
    );
    return { games };
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
        `SELECT s.id,s.name,s.status,s.mode,s.adventure_id,s.difficulty,s.catalog_version,pinned_catalog.entries AS catalog_snapshot,s.last_active_at,s.character,s.premise,s.owner_account_id,snap.state,snap.seq
      FROM sessions s LEFT JOIN catalog_snapshots pinned_catalog ON pinned_catalog.catalog_version=s.catalog_version
      LEFT JOIN LATERAL (SELECT state,seq FROM snapshots WHERE session_id=s.id ORDER BY seq DESC LIMIT 1) snap ON true
      WHERE s.id=$1 AND ((s.mode='solo' AND s.owner_account_id=$2) OR (s.mode='party' AND ${currentMemberSql('$2')}))`,
        [request.params.id, accountId],
      );
      const row = result.rows[0] as
        | (Record<string, unknown> & { state?: Record<string, unknown> })
        | undefined;
      if (!row) {
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
      const { tier: recapTier, tableLines: recapTableLines } =
        await recapSafety(request.params.id);
      const prior = (row.state?.recap ??
        (row.state?.gameState as Record<string, unknown> | undefined)
          ?.recap) as
        | { recap: string; memoryHash: string; provenanceVersion?: number }
        | undefined;
      const endpointSlot = process.env.SOLO_TURN_ENDPOINT_SLOT ?? 'fast';
      const mode = fixtureModeFromEnvironment();
      let adapter;
      if (await liveDmAllowed(db, accountId, liveDmAllowlistOnly, mode)) {
        try {
          const raw = await createConfiguredAdapter(
            db,
            endpointSlot as 'fast' | 'frontier' | 'moderate',
            createEndpointEgress(),
          );
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
      }
      const room = await rooms.get(request.params.id);
      const generatedRecap = await buildResumeRecap({
        hidden: concealedEntities(room?.state?.gameState),
        db,
        sessionId: request.params.id,
        accountId,
        previousSnapshotRecap: prior,
        adapter,
      });
      const recap = await gateRecap(
        generatedRecap,
        recapModerator,
        recapTier,
        recapTableLines,
        request.params.id,
      );
      if (row.mode === 'solo')
        await db.query(
          "UPDATE sessions SET last_active_at=now(),status='active' WHERE id=$1 AND owner_account_id=$2 AND mode='solo'",
          [request.params.id, accountId],
        );
      await room.persistRecap({
        recap: recap.recap,
        memoryHash: recap.memoryHash,
        provenanceVersion: RECAP_PROVENANCE_VERSION,
      });
      return {
        game: {
          ...gameView({ ...row, recap: { recap: recap.recap } }),
          recap: recap.recap,
          state: room.clientState(),
          catalogVersion: row.catalog_version,
        },
      };
    },
  );
}
