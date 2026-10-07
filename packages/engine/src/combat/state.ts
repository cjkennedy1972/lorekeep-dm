export type Combatant = {
  id: string;
  initiativeModifier: number;
  speed: number;
};

export type InitiativeEntry = {
  entityId: string;
  total: number;
  dexterity: number;
  /** Stable tie-break position supplied by startCombat. */
  tieOrder: number;
};

export type CombatResources = {
  action: boolean;
  bonusAction: boolean;
  reaction: boolean;
  movementRemaining: number;
};

export type CombatState = {
  combatants: Combatant[];
  initiative: InitiativeEntry[];
  round: number;
  turnIndex: number;
  activeEntityId: string | null;
  resources: Record<string, CombatResources>;
};

export type CombatEvent =
  | { type: 'CombatStarted'; combatants: Combatant[] }
  | { type: 'InitiativeRolled'; entityId: string; total: number }
  | { type: 'TurnStarted'; entityId: string; round: number }
  | { type: 'TurnEnded'; entityId: string }
  | { type: 'ActionSpent'; entityId: string }
  | { type: 'BonusActionSpent'; entityId: string }
  | { type: 'ReactionSpent'; entityId: string }
  | { type: 'MovementSpent'; entityId: string; feet: number };

export const emptyCombatState = (): CombatState => ({
  combatants: [],
  initiative: [],
  round: 0,
  turnIndex: -1,
  activeEntityId: null,
  resources: {},
});

/** Pure event reducer. Invalid event sequences are rejected rather than repaired. */
export function apply(state: CombatState, event: CombatEvent): CombatState {
  switch (event.type) {
    case 'CombatStarted':
      return {
        combatants: event.combatants.map((c) => ({ ...c })),
        initiative: [],
        round: 0,
        turnIndex: -1,
        activeEntityId: null,
        resources: {},
      };
    case 'InitiativeRolled': {
      const combatant = state.combatants.find((c) => c.id === event.entityId);
      if (!combatant) throw new Error(`Unknown combatant: ${event.entityId}`);
      const previous = state.initiative.filter(
        (i) => i.entityId !== event.entityId,
      );
      const entry = {
        entityId: event.entityId,
        total: event.total,
        dexterity: combatant.initiativeModifier,
        tieOrder: state.combatants.findIndex((c) => c.id === event.entityId),
      };
      const initiative = [...previous, entry].sort(
        (a, b) =>
          b.total - a.total ||
          b.dexterity - a.dexterity ||
          a.tieOrder - b.tieOrder,
      );
      return { ...state, initiative };
    }
    case 'TurnStarted': {
      const combatant = state.combatants.find((c) => c.id === event.entityId);
      if (
        !combatant ||
        !state.initiative.some((i) => i.entityId === event.entityId)
      ) {
        throw new Error(
          `Cannot start turn for ${event.entityId}: initiative is missing`,
        );
      }
      return {
        ...state,
        round: event.round,
        turnIndex: state.initiative.findIndex(
          (i) => i.entityId === event.entityId,
        ),
        activeEntityId: event.entityId,
        resources: {
          ...state.resources,
          [event.entityId]: {
            action: true,
            bonusAction: true,
            reaction: true,
            movementRemaining: combatant.speed,
          },
        },
      };
    }
    case 'TurnEnded':
      if (state.activeEntityId !== event.entityId)
        throw new Error('Cannot end a turn that is not active');
      return { ...state, activeEntityId: null };
    case 'ActionSpent':
    case 'BonusActionSpent':
    case 'ReactionSpent': {
      const resources = state.resources[event.entityId];
      if (!resources)
        throw new Error(`No turn resources for ${event.entityId}`);
      const key =
        event.type === 'ActionSpent'
          ? 'action'
          : event.type === 'BonusActionSpent'
            ? 'bonusAction'
            : 'reaction';
      return {
        ...state,
        resources: {
          ...state.resources,
          [event.entityId]: {
            ...resources,
            [key]: false,
          },
        },
      };
    }
    case 'MovementSpent': {
      const resources = state.resources[event.entityId];
      if (!resources)
        throw new Error(`No turn resources for ${event.entityId}`);
      if (
        !Number.isInteger(event.feet) ||
        event.feet <= 0 ||
        event.feet > resources.movementRemaining
      ) {
        throw new Error(`Invalid movement spend for ${event.entityId}`);
      }
      return {
        ...state,
        resources: {
          ...state.resources,
          [event.entityId]: {
            ...resources,
            movementRemaining: resources.movementRemaining - event.feet,
          },
        },
      };
    }
  }
}

export function replay(
  start: CombatState,
  events: readonly CombatEvent[],
): CombatState {
  return events.reduce(apply, start);
}
