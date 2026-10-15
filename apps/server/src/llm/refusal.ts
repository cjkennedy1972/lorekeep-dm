import { LlmEndpointError, type LlmChunk } from './adapter.js';

/**
 * Provider refusal of a mature-tier prompt. Matches only an HTTP 400/403 from the endpoint;
 * the status is the sole signal, so a 400 that is not a refusal also counts (the caller
 * only consults this for mature turns).
 */
export function isMatureRefusal(error: unknown): boolean {
  return (
    error instanceof LlmEndpointError &&
    error.code === 'endpoint-error' &&
    (error.status === 400 || error.status === 403)
  );
}

export async function* watchMatureRefusal(
  source: AsyncIterable<LlmChunk>,
  onRefusal: () => void,
): AsyncIterable<LlmChunk> {
  try {
    yield* source;
  } catch (error) {
    if (isMatureRefusal(error)) onRefusal();
    throw error;
  }
}
