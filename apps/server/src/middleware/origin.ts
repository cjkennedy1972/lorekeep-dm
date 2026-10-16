import type { FastifyRequest } from 'fastify';
export function originHostMatches(
  origin: URL,
  host: string | undefined,
): boolean {
  return !!host && origin.host === host;
}

export function validOrigin(request: FastifyRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser clients cannot be induced to send cookies cross-site
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === `${request.protocol}:` &&
      originHostMatches(parsed, request.headers.host)
    );
  } catch {
    return false;
  }
}
