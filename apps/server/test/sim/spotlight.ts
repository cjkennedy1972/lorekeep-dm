import type { SimTable } from './harness.js';

export interface SpotlightReport {
  /** Players with at least one accepted action (active and non-idle). */
  activePlayers: string[];
  /** Direct prompts per active player: RoundResolved batches that carried their action. */
  directPrompts: Record<string, number>;
  /** Active players with zero direct prompts. Empty means the metric passes. */
  unspotlit: string[];
}

/**
 * Spotlight, computed only from the persisted event log. A player is spotlit
 * for a turn when a RoundResolved batch that reached the DM includes their action.
 */
export async function spotlight(table: SimTable): Promise<SpotlightReport> {
  const accepted = await table.events('RoundActionAccepted');
  const resolved = await table.events('RoundResolved');
  const activePlayers = [
    ...new Set(
      accepted.map((event) => event.payload.submission.accountId as string),
    ),
  ];
  const directPrompts: Record<string, number> = {};
  for (const accountId of activePlayers) directPrompts[accountId] = 0;
  for (const event of resolved)
    for (const action of event.payload.actions as { accountId: string }[])
      if (action.accountId in directPrompts)
        directPrompts[action.accountId]! += 1;
  return {
    activePlayers,
    directPrompts,
    unspotlit: activePlayers.filter((id) => directPrompts[id] === 0),
  };
}
