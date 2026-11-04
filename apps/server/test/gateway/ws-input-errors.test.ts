import { describe, expect, it } from 'vitest';
import {
  actionFailureErrorPayload,
  inputBlockErrorPayload,
} from '../../src/gateway/ws.js';
import { RoomSeatRequiredError } from '../../src/room/Room.js';

describe('gateway action failure errors', () => {
  it('keeps an unexpected failure on the submit path retryable without leaking its cause', () => {
    const payload = actionFailureErrorPayload(
      new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      'edit-action',
    );
    expect(payload).toEqual({
      code: 'TURN_FAILED',
      message: 'Your action could not be sent. It is kept; try again.',
      actionId: 'edit-action',
    });
    expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED');
  });

  it('keeps the seat refusal non-retryable for an unbound seat', () => {
    expect(
      actionFailureErrorPayload(new RoomSeatRequiredError(), 'edit-action'),
    ).toEqual({
      code: 'ACTION_REJECTED',
      message: 'Action could not be accepted.',
      actionId: 'edit-action',
    });
  });

  it('keeps the room rejection for a full action queue', () => {
    expect(
      actionFailureErrorPayload(new Error('ACTION_REJECTED'), 'edit-action'),
    ).toEqual({
      code: 'ACTION_REJECTED',
      message: 'Action could not be accepted.',
      actionId: 'edit-action',
    });
  });
});

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
