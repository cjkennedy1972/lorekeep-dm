import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { CharacterSchema } from '@game/schema';
import { BoundedCounter } from '../accounts/throttle.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import {
  SeatCharacterError,
  SeatCharacterRepository,
} from '../persistence/seatCharacters.js';
import type { registerAuthRoutes } from './auth.js';
import { z } from 'zod';

type App = Parameters<typeof registerAuthRoutes>[0];
const characterDataSchema = CharacterSchema.omit({ id: true });
const createCharacterInput = z
  .object({
    character: characterDataSchema.extend({ id: z.string().optional() }),
  })
  .strict();
const updateCharacterInput = z
  .object({
    id: z.uuid(),
    expectedRevision: z.number().int().positive(),
    character: characterDataSchema,
  })
  .strict();

export function registerCharacterRoutes(app: App, db: Pool) {
  const repository = new SeatCharacterRepository(db);
  const writes = new BoundedCounter(60_000);

  app.get('/api/me/characters', async (request, reply) => {
    if (!validOrigin(request))
      return reply
        .code(403)
        .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
    const auth = await authenticateRequest(db, request);
    if (!auth)
      return reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required.',
        loginRequired: true,
      });
    return {
      characters: await repository.listOwnedCharacters(auth.account_id),
    };
  });

  app.post('/api/me/characters', async (request, reply) => {
    if (!validOrigin(request))
      return reply
        .code(403)
        .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
    const auth = await authenticateRequest(db, request);
    if (!auth)
      return reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required.',
        loginRequired: true,
      });
    const body = request.body;
    const isUpdate =
      typeof body === 'object' && body !== null && 'expectedRevision' in body;
    const parsed = isUpdate
      ? updateCharacterInput.safeParse(body)
      : createCharacterInput.safeParse(body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_CHARACTER',
        message: 'Character could not be saved.',
      });
    // Count every valid write attempt, including conflicts and failed writes.
    if (writes.hit(auth.account_id) > 10)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      });

    try {
      const id = isUpdate
        ? (parsed.data as z.infer<typeof updateCharacterInput>).id
        : randomUUID();
      const character = { ...parsed.data.character, id };
      const expectedRevision = isUpdate
        ? (parsed.data as z.infer<typeof updateCharacterInput>).expectedRevision
        : undefined;
      const revision = await repository.saveOwnedCharacter(
        auth.account_id,
        character,
        expectedRevision,
      );
      return reply.code(isUpdate ? 200 : 201).send({
        id,
        revision,
        name: character.name,
        classId: character.classId,
        speciesId: character.speciesId,
        level: character.level,
      });
    } catch (error) {
      if (!(error instanceof SeatCharacterError)) throw error;
      const status =
        error.code === 'INVALID_CHARACTER'
          ? 400
          : error.code === 'ACCOUNT_INACTIVE'
            ? 403
            : error.code === 'NOT_FOUND' || error.code === 'NOT_OWNER'
              ? 404
              : 409;
      return reply.code(status).send({
        code:
          error.code === 'NOT_FOUND' || error.code === 'NOT_OWNER'
            ? 'NOT_FOUND'
            : error.code,
        message: 'Character could not be saved.',
      });
    }
  });
}
