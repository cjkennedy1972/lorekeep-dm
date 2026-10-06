import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { getSession, tokenFromCookie } from '../accounts/sessions.js';
export async function authenticateRequest(db: Pool, request: FastifyRequest) {
  const token = tokenFromCookie(request.headers.cookie);
  if (!token) return undefined;
  return getSession(db, token);
}
