import type { Pool } from 'pg';
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
const saveCharacterInput = z
  .object({
    character: CharacterSchema,
    expectedRevision: z.number().int().positive().optional(),
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
    return repository.listOwnedCharacters(auth.account_id);
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
    const parsed = saveCharacterInput.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_CHARACTER',
        message: 'Character could not be saved.',
      });
    if (writes.hit(auth.account_id) > 10)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      });

    try {
      const revision = await repository.saveOwnedCharacter(
        auth.account_id,
        parsed.data.character,
        parsed.data.expectedRevision,
      );
      return reply
        .code(parsed.data.expectedRevision === undefined ? 201 : 200)
        .send({ id: parsed.data.character.id, revision });
    } catch (error) {
      if (!(error instanceof SeatCharacterError)) throw error;
      const status =
        error.code === 'INVALID_CHARACTER'
          ? 400
          : error.code === 'ACCOUNT_INACTIVE'
            ? 403
            : 409;
      return reply.code(status).send({
        code: error.code,
        message: 'Character could not be saved.',
      });
    }
  });
}
