import type { ServerMessage } from '@game/schema';
import type { CombatCommand } from '@game/schema';
import type { RoomState } from '@game/schema';
import { path, legalOptions, attack } from '@game/rules-engine';
import type { Battlemap, GridPos } from '@game/schema';

type CombatEntity = {
  id: string;
  kind: 'character' | 'monster' | 'npc';
  team: string;
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac?: number;
  speed?: number;
  attacks?: {
    id: string;
    name: string;
    reachFt?: number;
    attackBonus: number;
    damage: string;
    damageType: string;
    range?: { normalFt: number; longFt?: number };
  }[];
};
export type RoomCombatState = {
  map: Battlemap;
  entities: CombatEntity[];
  combat: {
    round: number;
    activeEntityId: string | null;
    initiative: { entityId: string; total: number }[];
    resources: Record<
      string,
      {
        action: boolean;
        bonusAction: boolean;
        reaction: boolean;
        movementRemaining: number;
      }
    >;
  };
  pendingReaction?: {
    reactionId: string;
    entityId: string;
    trigger: string;
    moverId: string;
  };
  pendingActionIds?: string[];
  seed?: number;
};
export type CombatTransition = {
  state: RoomCombatState;
  events: Record<string, unknown>[];
  messages?: { type: string; payload: Record<string, unknown> }[];
};
export type CombatCommandError = {
  code: 'NOT_YOUR_TURN' | 'COMMAND_REJECTED';
  message: string;
};
export type CombatRuntime = {
  preview(state: RoomCombatState, actorId: string): unknown;
  execute(
    state: RoomCombatState,
    actorId: string,
    command: CombatCommand['payload'],
  ): CombatTransition | CombatCommandError;
  decideMonsters?(state: RoomCombatState): CombatTransition;
};

/** Stable client projection; exact enemy HP is private while the active token always matches initiative. */
export function combatTracker(state: RoomCombatState) {
  const active =
    state.combat.activeEntityId ?? state.combat.initiative[0]?.entityId ?? null;
  const activeIndex = Math.max(
    0,
    state.combat.initiative.findIndex((item) => item.entityId === active),
  );
  const ordered = [
    ...state.combat.initiative.slice(activeIndex),
    ...state.combat.initiative.slice(0, activeIndex),
  ];
  return {
    round: state.combat.round,
    initiative: ordered.map(({ entityId, total }) => ({ entityId, total })),
    activeEntityId: active,
    entities: state.entities.map(({ id, kind, team, hp, maxHp, pos }) => ({
      id,
      kind,
      team,
      ...(team === 'party' ? { hp } : {}),
      hpState:
        hp <= 0
          ? 'down'
          : hp / Math.max(1, maxHp) > 0.5
            ? 'healthy'
            : 'wounded',
      pos,
    })),
    resources: state.combat.resources,
  };
}

export function createCombatRuntime(): CombatRuntime {
  return {
    preview(state, actorId) {
      const entity = state.entities.find((item) => item.id === actorId);
      if (!entity) return { actions: [] };
      const resources = state.combat.resources[actorId];
      return legalOptions(
        {
          map: state.map,
          entities: state.entities.map((item) => ({
            ...item,
            team: item.team,
          })),
          resources: Object.fromEntries(
            Object.entries(state.combat.resources).map(([id, r]) => [
              id,
              {
                action: r.action,
                bonusAction: r.bonusAction,
                movementLeft: r.movementRemaining,
              },
            ]),
          ),
        },
        actorId,
      );
    },
    execute(state, actorId, command) {
      if (state.pendingReaction && command.command !== 'reaction')
        return {
          code: 'COMMAND_REJECTED',
          message: 'Resolve the pending reaction first.',
        };
      const active =
        state.combat.activeEntityId ?? state.combat.initiative[0]?.entityId;
      if (command.command !== 'reaction' && actorId !== active)
        return { code: 'NOT_YOUR_TURN', message: 'It is not your turn.' };
      if (command.command === 'options')
        return {
          state,
          events: [],
          messages: [
            {
              type: 'CombatOptions',
              payload: this.preview(state, actorId) as Record<string, unknown>,
            },
          ],
        };
      if (command.command === 'attack') {
        const attacker = state.entities.find((item) => item.id === actorId);
        const target = state.entities.find(
          (item) => item.id === command.targetId,
        );
        const weapon = attacker?.attacks?.find(
          (item) => item.id === command.attackId,
        );
        const resource = state.combat.resources[actorId];
        if (
          !attacker ||
          !target ||
          !weapon ||
          !resource?.action ||
          target.hp <= 0
        )
          return {
            code: 'COMMAND_REJECTED',
            message: 'That attack is not currently available.',
          };
        const result = attack({
          attackerId: actorId,
          targetId: target.id,
          attackId: weapon.id,
          seed: state.seed ?? 1,
          attackBonus: weapon.attackBonus,
          damage: weapon.damage,
          damageType: weapon.damageType,
          targetAc: target.ac ?? 10,
          target: {
            hp: target.hp,
            kind: target.kind === 'character' ? 'pc' : 'monster',
          },
          map: {
            map: state.map,
            attacker,
            target,
            ...(weapon.range
              ? { range: weapon.range }
              : { reachFt: weapon.reachFt ?? 5 }),
          },
        });
        if ('error' in result)
          return {
            code: 'COMMAND_REJECTED',
            message: 'That target is not a legal attack.',
          };
        const hp = result.events.find((event) => event.type === 'HpChanged');
        const entities =
          hp?.type === 'HpChanged'
            ? state.entities.map((item) =>
                item.id === hp.entityId ? { ...item, hp: hp.to } : item,
              )
            : state.entities;
        return {
          state: {
            ...state,
            entities,
            seed: result.rng,
            combat: {
              ...state.combat,
              resources: {
                ...state.combat.resources,
                [actorId]: { ...resource, action: false },
              },
            },
          },
          events: [
            ...result.events,
            { type: 'ActionSpent', entityId: actorId },
          ],
        };
      }
      if (command.command === 'end-turn') {
        const index = state.combat.initiative.findIndex(
          (entry) => entry.entityId === actorId,
        );
        if (index < 0 || !state.combat.initiative.length)
          return {
            code: 'COMMAND_REJECTED',
            message: 'Combat initiative is unavailable.',
          };
        const nextIndex = (index + 1) % state.combat.initiative.length;
        const nextId = state.combat.initiative[nextIndex]!.entityId;
        const round = state.combat.round + (nextIndex === 0 ? 1 : 0);
        const nextEntity = state.entities.find(
          (entity) => entity.id === nextId,
        );
        const combat = {
          ...state.combat,
          round,
          activeEntityId: nextId,
          resources: {
            ...state.combat.resources,
            [nextId]: {
              action: true,
              bonusAction: true,
              reaction: true,
              movementRemaining: nextEntity?.speed ?? 30,
            },
          },
        };
        return {
          state: { ...state, combat },
          events: [
            { type: 'TurnEnded', entityId: actorId },
            { type: 'TurnStarted', entityId: nextId, round },
          ],
        };
      }
      if (command.command === 'move') {
        const entity = state.entities.find((item) => item.id === actorId);
        if (!entity)
          return {
            code: 'COMMAND_REJECTED',
            message: 'That actor is not on the map.',
          };
        const result = path(
          {
            map: state.map,
            entities: state.entities,
            resources: Object.fromEntries(
              Object.entries(state.combat.resources).map(([id, r]) => [
                id,
                { movementLeft: r.movementRemaining },
              ]),
            ),
          },
          actorId,
          command.destination,
        );
        if ('error' in result)
          return {
            code: 'COMMAND_REJECTED',
            message: 'That destination is not reachable.',
          };
        return {
          state: {
            ...state,
            entities: state.entities.map((item) =>
              item.id === actorId
                ? { ...item, pos: command.destination }
                : item,
            ),
            combat: {
              ...state.combat,
              resources: {
                ...state.combat.resources,
                [actorId]: {
                  ...state.combat.resources[actorId]!,
                  movementRemaining: Math.max(
                    0,
                    state.combat.resources[actorId]!.movementRemaining -
                      result.cost,
                  ),
                },
              },
            },
          },
          events: [
            {
              type: 'EntityMoved',
              entityId: actorId,
              path: result.path,
              cost: result.cost,
            },
          ],
        };
      }
      return {
        code: 'COMMAND_REJECTED',
        message: 'That combat command is not configured for this encounter.',
      };
    },
  };
}

export function trackerMessage(
  seq: number,
  state: RoomCombatState,
): ServerMessage {
  return {
    seq,
    type: 'CombatTracker',
    payload: combatTracker(state),
  } as ServerMessage;
}
export function reactionMessage(
  seq: number,
  reaction: NonNullable<RoomCombatState['pendingReaction']>,
): ServerMessage {
  return {
    seq,
    type: 'ReactionPrompt',
    payload: { ...reaction, timeoutMs: 15_000, defaultChoice: 'decline' },
  } as ServerMessage;
}
export type CombatCommandInput = {
  accountId: string;
  actionId: string;
  command: CombatCommand['payload'];
};
export type CombatCommandHandler = (
  input: CombatCommandInput,
) => Promise<CombatCommandError | void>;
export function roomGameState(
  room: Pick<RoomState, 'gameState'>,
): RoomCombatState | null {
  const state = room.gameState as { combatRoom?: RoomCombatState } | undefined;
  return state?.combatRoom ?? null;
}
