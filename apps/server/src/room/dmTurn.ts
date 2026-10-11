import type { DMTurnEvent } from '@game/schema';
import type { TurnResult } from '../dm/orchestrator.js';

export interface SoloTurnRequest {
  sessionId: string;
  accountId: string;
  actionId: string;
  text: string;
  state: unknown;
  playerName?: string;
  allowClarification?: boolean;
  clarificationAsked?: boolean;
  signal?: AbortSignal;
}

export class LiveDmRestrictedError extends Error {
  constructor() {
    super('LIVE_DM_RESTRICTED');
    this.name = 'LiveDmRestrictedError';
  }
}

/** Runtime-specific prompt, endpoint, and engine bindings stay outside the Room actor. */
export interface SoloTurnRunner {
  run(
    request: SoloTurnRequest,
    onEvent: (
      event: DMTurnEvent | { type: string; [key: string]: unknown },
    ) => void,
  ): Promise<TurnResult>;
}
