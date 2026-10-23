export type RestVoteChoice = 'yes' | 'no';
export type RestVoteCloseReason =
  | 'majority'
  | 'no-majority-early'
  | 'no-majority'
  | 'host-tiebreak'
  | 'tie-failed'
  | 'expired'
  | 'cancelled'
  | 'cancelled-combat';

export type RestVote = {
  voteId: string;
  type: 'short' | 'long';
  eligibleSeats: string[];
  ballots: { seat: string; choice: RestVoteChoice }[];
  tieBreak?: RestVoteChoice;
  openedByTurnId: string;
  deadlineAt: number;
};

export type RestVoteClose = {
  outcome: 'passed' | 'failed';
  closeReason: RestVoteCloseReason;
  yes: number;
  no: number;
};

export function cancelRestVoteForCombat(): RestVoteClose {
  return {
    outcome: 'failed',
    closeReason: 'cancelled-combat',
    yes: 0,
    no: 0,
  };
}

export function voteTally(vote: RestVote): { yes: number; no: number } {
  const yes = vote.ballots.filter((ballot) => ballot.choice === 'yes').length;
  const no = vote.ballots.filter((ballot) => ballot.choice === 'no').length;
  return { yes, no };
}

/**
 * Determine whether the current vote is closable. This function has no effects;
 * callers must invoke it and persist the close within the Room mailbox.
 */
export function evaluateRestVote(
  vote: RestVote,
  now: number,
  hostRevoked = false,
): RestVoteClose | undefined {
  const n = vote.eligibleSeats.length;
  const { yes, no } = voteTally(vote);
  const cast = vote.ballots.length;
  const uncast = n - cast;

  if (yes > n / 2)
    return { outcome: 'passed', closeReason: 'majority', yes, no };

  if (hostRevoked && yes === no)
    return { outcome: 'failed', closeReason: 'tie-failed', yes, no };

  if (now >= vote.deadlineAt) {
    if (yes === no)
      return { outcome: 'failed', closeReason: 'tie-failed', yes, no };
    return { outcome: 'failed', closeReason: 'expired', yes, no };
  }

  if (cast === n && yes !== no)
    return {
      outcome: yes > no ? 'passed' : 'failed',
      closeReason: yes > no ? 'majority' : 'no-majority',
      yes,
      no,
    };

  if (cast === n && yes === no && vote.tieBreak) {
    return {
      outcome: vote.tieBreak === 'yes' ? 'passed' : 'failed',
      closeReason: 'host-tiebreak',
      yes,
      no,
    };
  }

  // Strict inequality is intentional: a reachable tie must reach the host.
  if (yes + uncast < n / 2)
    return { outcome: 'failed', closeReason: 'no-majority-early', yes, no };

  return undefined;
}

export function castRestVote(
  vote: RestVote,
  seatId: string,
  choice: RestVoteChoice,
  kind: 'ballot' | 'tiebreak',
): RestVote | undefined {
  if (!vote.eligibleSeats.includes(seatId)) return undefined;
  if (kind === 'ballot') {
    if (vote.ballots.some((ballot) => ballot.seat === seatId)) return undefined;
    return { ...vote, ballots: [...vote.ballots, { seat: seatId, choice }] };
  }
  const { yes, no } = voteTally(vote);
  if (
    vote.tieBreak ||
    vote.ballots.length !== vote.eligibleSeats.length ||
    yes !== no
  )
    return undefined;
  return { ...vote, tieBreak: choice };
}
