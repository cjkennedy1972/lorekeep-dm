import { nextDie } from '../rng.js';
import { type CombatEvent, type CombatState, type Combatant } from './state.js';

export type CommandResult =
  | { ok: true; events: CombatEvent[] }
  | { error: string; hint: string };
const fail = (error: string, hint: string): CommandResult => ({ error, hint });
const done = (events: CombatEvent[]): CommandResult => ({ ok: true, events });

export function startCombat(
  _state: CombatState,
  combatants: Combatant[],
): CommandResult {
  if (!combatants.length)
    return fail(
      'Combat requires at least one combatant.',
      'Add at least one combatant before starting combat.',
    );
  if (new Set(combatants.map((c) => c.id)).size !== combatants.length)
    return fail(
      'Combatant IDs must be unique.',
      'Remove duplicate combatant IDs.',
    );
  if (
    combatants.some(
      (c) =>
        !c.id ||
        !Number.isInteger(c.initiativeModifier) ||
        !Number.isInteger(c.speed) ||
        c.speed < 0,
    )
  ) {
    return fail(
      'Combatant data is invalid.',
      'Provide a non-empty ID, integer Dexterity modifier, and non-negative integer speed for each combatant.',
    );
  }
  const events: CombatEvent[] = [
    { type: 'CombatStarted', combatants: combatants.map((c) => ({ ...c })) },
  ];
  return done(events);
}

/** Roll d20 initiative in participant order; ties sort by higher Dex, then input order. */
export function rollInitiative(
  state: CombatState,
  seed: number,
): CommandResult {
  if (!state.combatants.length)
    return fail(
      'Combat has not started.',
      'Start combat before rolling initiative.',
    );
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    return fail('Invalid RNG seed.', 'Provide a uint32 seed from the server.');
  let rng = seed;
  const events: CombatEvent[] = [];
  for (const combatant of state.combatants) {
    const [die, next] = nextDie(rng, 20);
    rng = next;
    events.push({
      type: 'InitiativeRolled',
      entityId: combatant.id,
      total: die + combatant.initiativeModifier,
    });
  }
  return done(events);
}

export function startTurn(state: CombatState, entityId: string): CommandResult {
  if (state.activeEntityId)
    return fail(
      'A turn is already active.',
      'End the active turn before starting another.',
    );
  if (!state.initiative.length)
    return fail(
      'Initiative has not been rolled.',
      'Roll initiative before starting a turn.',
    );
  const current = state.turnIndex;
  const index = state.initiative.findIndex(
    (entry) => entry.entityId === entityId,
  );
  const expected = (current + 1) % state.initiative.length;
  if (index !== expected)
    return fail(
      'Combatant is out of turn order.',
      `The next combatant is ${state.initiative[expected]!.entityId}.`,
    );
  const round = current < 0 || index === 0 ? state.round + 1 : state.round;
  const event: CombatEvent = { type: 'TurnStarted', entityId, round };
  return done([event]);
}

export function endTurn(state: CombatState): CommandResult {
  if (!state.activeEntityId)
    return fail('No turn is active.', 'Start the next combatant’s turn first.');
  const event: CombatEvent = {
    type: 'TurnEnded',
    entityId: state.activeEntityId,
  };
  return done([event]);
}

export function spendAction(state: CombatState): CommandResult {
  return spendResource(state, 'action', {
    type: 'ActionSpent',
    entityId: state.activeEntityId ?? '',
  });
}
export function spendBonusAction(state: CombatState): CommandResult {
  return spendResource(state, 'bonusAction', {
    type: 'BonusActionSpent',
    entityId: state.activeEntityId ?? '',
  });
}
export function spendReaction(state: CombatState): CommandResult {
  return spendResource(state, 'reaction', {
    type: 'ReactionSpent',
    entityId: state.activeEntityId ?? '',
  });
}
function spendResource(
  state: CombatState,
  key: 'action' | 'bonusAction' | 'reaction',
  event: CombatEvent,
): CommandResult {
  const id = state.activeEntityId;
  if (!id)
    return fail(
      'No turn is active.',
      'Start a combatant’s turn before spending a resource.',
    );
  if (!state.resources[id]?.[key])
    return fail(
      `${key === 'action' ? 'Action' : key === 'bonusAction' ? 'Bonus action' : 'Reaction'} already spent.`,
      `Each turn allows one ${key === 'bonusAction' ? 'bonus action' : key}; wait until your next turn to regain it.`,
    );
  return done([event]);
}
export function spendMovement(state: CombatState, feet: number): CommandResult {
  const id = state.activeEntityId;
  if (!id)
    return fail(
      'No turn is active.',
      'Start a combatant’s turn before moving.',
    );
  if (!Number.isInteger(feet) || feet <= 0)
    return fail(
      'Movement distance must be a positive integer.',
      'Spend movement in whole feet greater than zero.',
    );
  if (feet > state.resources[id]!.movementRemaining)
    return fail(
      'Insufficient movement remaining.',
      `You have ${state.resources[id]!.movementRemaining} feet remaining this turn.`,
    );
  const event: CombatEvent = { type: 'MovementSpent', entityId: id, feet };
  return done([event]);
}
