import type { LlmChunk } from './adapter.js';

/**
 * A refusal needs the provider's refusal marker from the response body, which
 * LlmEndpointError does not carry. Until the body is plumbed through both dialects,
 * no 400/403 counts as a refusal: the turn fails closed and the runner is not demoted.
 */
export function isMatureRefusal(_error: unknown): boolean {
  return false;
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
