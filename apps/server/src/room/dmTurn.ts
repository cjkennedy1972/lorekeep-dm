import type { DMTurnEvent } from '@game/schema';
import type { TurnResult } from '../dm/orchestrator.js';

export interface SoloTurnRequest {
  sessionId: string;
  accountId: string;
  actionId: string;
  text: string;
  state: unknown;
  playerName?: string;
  lastRestVoteResult?: {
    voteId: string;
    type: 'short' | 'long';
    outcome: 'passed' | 'failed';
    closeReason: string;
  };
  allowClarification?: boolean;
  clarificationAsked?: boolean;
  steerAway?: boolean;
  /** Combat narration turn: read-only tool scope (ADR-034 §2). */
  combatNarration?: boolean;
  signal?: AbortSignal;
}

export class LiveDmRestrictedError extends Error {
  constructor() {
    super('LIVE_DM_RESTRICTED');
    this.name = 'LiveDmRestrictedError';
  }
}

/** The host-enabled X-card path stopped this turn intentionally. */
export class XCardAbortError extends Error {
  constructor() {
    super('X_CARD_ABORTED');
    this.name = 'XCardAbortError';
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
