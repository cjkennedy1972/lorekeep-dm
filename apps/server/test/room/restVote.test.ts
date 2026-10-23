import { describe, expect, it } from 'vitest';
import {
  castRestVote,
  cancelRestVoteForCombat,
  evaluateRestVote,
  type RestVote,
} from '../../src/room/restVote.js';

const vote = (size = 5): RestVote => ({
  voteId: 'vote-1',
  type: 'short',
  eligibleSeats: ['host', 'a', 'b', 'c', 'd'].slice(0, size),
  ballots: [],
  openedByTurnId: 'turn-1',
  deadlineAt: 10,
});

describe('rest vote quorum and serialized close decisions', () => {
  it('does not close the reachable tie boundary early, then accepts exactly one host tie-break', () => {
    let current = vote(4);
    current = castRestVote(current, 'host', 'yes', 'ballot')!;
    current = castRestVote(current, 'a', 'no', 'ballot')!;
    current = castRestVote(current, 'b', 'no', 'ballot')!;
    expect(evaluateRestVote(current, 9)).toBeUndefined();

    current = castRestVote(current, 'c', 'yes', 'ballot')!;
    expect(evaluateRestVote(current, 9)).toBeUndefined();
    current = castRestVote(current, 'host', 'yes', 'tiebreak')!;
    expect(castRestVote(current, 'host', 'no', 'tiebreak')).toBeUndefined();
    expect(evaluateRestVote(current, 9)).toMatchObject({
      outcome: 'passed',
      closeReason: 'host-tiebreak',
      yes: 2,
      no: 2,
    });
  });

  it('closes by quorum when the final ballot commits before the timer deadline', () => {
    let current = vote();
    current = castRestVote(current, 'host', 'yes', 'ballot')!;
    current = castRestVote(current, 'a', 'yes', 'ballot')!;
    current = castRestVote(current, 'b', 'no', 'ballot')!;
    current = castRestVote(current, 'd', 'no', 'ballot')!;

    // The final no commits before deadline and completes N, so the timer cannot win later.
    current = castRestVote(current, 'c', 'no', 'ballot')!;
    expect(evaluateRestVote(current, 9)).toMatchObject({
      outcome: 'failed',
      closeReason: 'no-majority',
      yes: 2,
      no: 3,
    });
  });

  it('applies strict early failure, while equality at the threshold remains open', () => {
    let current = vote(4);
    current = castRestVote(current, 'host', 'no', 'ballot')!;
    current = castRestVote(current, 'a', 'no', 'ballot')!;
    expect(evaluateRestVote(current, 1)).toBeUndefined();
    current = castRestVote(current, 'b', 'no', 'ballot')!;
    expect(evaluateRestVote(current, 1)).toMatchObject({
      outcome: 'failed',
      closeReason: 'no-majority-early',
    });
  });

  it('closes a tie immediately if the host is revoked and cancels combat without effects', () => {
    let current = vote(4);
    current = castRestVote(current, 'host', 'yes', 'ballot')!;
    current = castRestVote(current, 'a', 'no', 'ballot')!;
    current = castRestVote(current, 'b', 'no', 'ballot')!;
    current = castRestVote(current, 'c', 'yes', 'ballot')!;
    expect(evaluateRestVote(current, 1, true)).toMatchObject({
      outcome: 'failed',
      closeReason: 'tie-failed',
    });
    expect(cancelRestVoteForCombat()).toEqual({
      outcome: 'failed',
      closeReason: 'cancelled-combat',
      yes: 0,
      no: 0,
    });
  });
});
