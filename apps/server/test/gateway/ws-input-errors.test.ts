import { describe, expect, it } from 'vitest';
import { inputBlockErrorPayload } from '../../src/gateway/ws.js';

describe('gateway input block errors', () => {
  it('maps a fail-closed edit verdict to a retryable storyteller failure', () => {
    expect(inputBlockErrorPayload('failclosed', 'edit-action')).toEqual({
      code: 'TURN_FAILED',
      message:
        'The storyteller is unavailable. Your action is kept; try again.',
      actionId: 'edit-action',
    });
  });

  it('keeps content blocks on the generic rejection path', () => {
    expect(inputBlockErrorPayload('judge', 'edit-action')).toEqual({
      code: 'CONTENT_REJECTED',
      message: 'That action cannot be sent.',
      actionId: 'edit-action',
    });
  });
});
