import type { ServerMessage } from '@game/schema';
import type { CombatCommand } from '@game/schema';
import type { RoomState } from '@game/schema';
import {
  path,
  legalOptions,
  attack,
  moveAlong,
  type Catalog,
  type RollBreakdown,
} from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/room-tools';
import {
  advanceTurn,
  answerReaction,
  applyMovement,
  expireReaction,
  movementState,
  runMonsters,
  settle,
  withHp,
} from './combatEngine.js';
import { reconcileCombat, type Reconciled } from './combatBootstrap.js';
import { areaOptions, castCommand } from './combatSpell.js';
import {
  type CombatCommandError,
  type CombatContext,
  type CombatTransition,
  type RoomCombatState,
} from './combatTypes.js';

export type {
  CombatCommandError,
  CombatContext,
  CombatEntity,
  CombatTransition,
  RoomCombatState,
} from './combatTypes.js';
export { REACTION_TIMEOUT_MS } from './combatTypes.js';

export type CombatRuntime = {
  preview(
    state: RoomCombatState,
    actorId: string,
    ctx?: CombatContext,
  ): unknown;
  execute(
    state: RoomCombatState,
    actorId: string,
    command: CombatCommand['payload'],
    ctx?: CombatContext,
  ): CombatTransition | CombatCommandError;
  /** Derive/clear the Room's combat from the engine state a DM turn produced. */
  reconcile(game: Record<string, unknown>, now?: number): Reconciled | null;
  /** Auto-decline a reaction prompt whose deadline passed. */
  expire(state: RoomCombatState, now: number): CombatTransition | null;
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
    entities: state.entities.map(
      ({ id, kind, team, hp, maxHp, pos, fled }) => ({
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
        ...(fled ? { fled } : {}),
      }),
    ),
    resources: state.combat.resources,
    ...(state.ended ? { ended: state.ended } : {}),
  };
}

const reject = (message: string): CombatCommandError => ({
  code: 'COMMAND_REJECTED',
  message,
});

export function createCombatRuntime(
  catalog: Catalog = defaultCatalog(),
): CombatRuntime {
  const optionsState = (
    state: RoomCombatState,
    actorId: string,
    ctx?: CombatContext,
  ) => ({
    map: state.map,
    entities: state.entities.filter((item) => !item.fled),
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
    ...(ctx?.character
      ? {
          casters: { [actorId]: ctx.character },
          catalog,
          spells: ctx.character.spellsPrepared.flatMap((id) => {
            const template = catalog.get('spell', id)?.template;
            return [
              {
                id,
                ...(template
                  ? {
                      template: {
                        shape: template.shape,
                        size: template.size,
                        width: template.width,
                      },
                    }
                  : {}),
              },
            ];
          }),
        }
      : {}),
  });
  const runtime: CombatRuntime = {
    preview(state, actorId, ctx) {
      if (!state.entities.some((item) => item.id === actorId))
        return { actions: [] };
      return legalOptions(
        optionsState(state, actorId, ctx) as Parameters<typeof legalOptions>[0],
        actorId,
      );
    },
    reconcile(game, now = Date.now()) {
      return reconcileCombat(game, catalog, now);
    },
    expire: expireReaction,
    execute(state, actorId, command, ctx) {
      const now = ctx?.now ?? Date.now();
      if (state.ended) return reject('Combat is over.');
      if (command.command === 'reaction')
        return answerReaction(
          state,
          actorId,
          command.reactionId,
          command.choice,
          now,
        );
      if (state.pendingReaction)
        return reject('Resolve the pending reaction first.');
      const active =
        state.combat.activeEntityId ?? state.combat.initiative[0]?.entityId;
      if (actorId !== active)
        return { code: 'NOT_YOUR_TURN', message: 'It is not your turn.' };
      if (command.command === 'options') {
        const preview = runtime.preview(state, actorId, ctx) as Record<
          string,
          unknown
        >;
        const areas = (ctx?.character?.spellsPrepared ?? []).flatMap((id) =>
          areaOptions(state, actorId, id, catalog).map((option) => ({
            spellId: id,
            ...option,
          })),
        );
        return {
          state,
          events: [],
          messages: [{ type: 'CombatOptions', payload: { ...preview, areas } }],
        };
      }
      if (command.command === 'cast') {
        const cast = castCommand(
          state,
          actorId,
          command,
          ctx?.character,
          catalog,
        );
        if ('code' in cast) return cast;
        return cast;
      }
      const resource = state.combat.resources[actorId];
      if (command.command === 'attack') {
        const attacker = state.entities.find((item) => item.id === actorId);
        const target = state.entities.find(
          (item) => item.id === command.targetId,
        );
        const weapon = attacker?.attacks?.find(
          (item) => item.id === command.attackId,
        );
        if (
          !attacker ||
          !target ||
          !weapon ||
          !resource?.action ||
          target.hp <= 0 ||
          target.fled
        )
          return reject('That attack is not currently available.');
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
          return reject('That target is not a legal attack.');
        const hit = withHp(
          {
            ...state,
            seed: result.rng,
            combat: {
              ...state.combat,
              resources: {
                ...state.combat.resources,
                [actorId]: { ...resource, action: false },
              },
            },
          },
          result.events,
        );
        const closing = settle(hit.state);
        return {
          state: closing.state,
          events: [
            ...result.events,
            ...hit.events,
            { type: 'ActionSpent', entityId: actorId },
            ...closing.events,
          ],
        };
      }
      if (command.command === 'end-turn') {
        if (!state.combat.initiative.length)
          return reject('Combat initiative is unavailable.');
        const next = advanceTurn(state);
        const run = runMonsters(next.state, now);
        return { state: run.state, events: [...next.events, ...run.events] };
      }
      if (command.command === 'move') {
        const entity = state.entities.find((item) => item.id === actorId);
        if (!entity) return reject('That actor is not on the map.');
        const mv = movementState(state, actorId);
        const route = path(mv, actorId, command.destination);
        if ('error' in route)
          return reject('That destination is not reachable.');
        const moved = moveAlong(mv, actorId, route.path, 'normal');
        if ('error' in moved) return reject(moved.hint);
        const next = applyMovement(
          state,
          actorId,
          moved.state,
          moved.pending,
          now,
        );
        // One EntityMoved for the whole path unless a reaction interrupted it.
        const events: Record<string, unknown>[] = moved.pending.length
          ? (moved.events as unknown as Record<string, unknown>[])
          : [
              {
                type: 'EntityMoved',
                entityId: actorId,
                path: route.path,
                cost: route.cost,
              },
            ];
        return { state: next, events };
      }
      return reject(
        'That combat command is not configured for this encounter.',
      );
    },
  };
  return runtime;
}

let cached: Catalog | undefined;
function defaultCatalog(): Catalog {
  return (cached ??= loadCatalog());
}

/** Engine events as the wire schema (EngineEventSchema) spells them. */
export function toWireEvent(
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (event.type === 'SlotSpent' && event.level === undefined)
    return { ...event, level: event.slotLevel };
  if (event.type === 'RollEvent' && event.breakdown) {
    const roll = event.breakdown as RollBreakdown;
    return {
      type: 'RollEvent',
      actorId: event.entityId,
      label: `${String(event.kind)} ${String(event.attackId ?? event.spellId)}`,
      dice: roll.expression,
      rolls: roll.dice.filter((die) => die.kept).map((die) => die.value),
      modifier: roll.modifiers.reduce((sum, m) => sum + m.value, 0),
      total: roll.total,
      ...(event.dc === undefined
        ? {}
        : { dc: event.dc, success: event.success }),
    };
  }
  return { ...event };
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
  now = Date.now(),
): ServerMessage {
  return {
    seq,
    type: 'ReactionPrompt',
    payload: {
      ...reaction,
      timeoutMs: Math.max(0, reaction.deadlineAt - now),
      defaultChoice: 'decline',
    },
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
