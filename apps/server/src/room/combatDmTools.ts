import { execute, type ToolExecutorState } from '@game/rules-engine/room-tools';
import type { Catalog, CharacterInput } from '@game/rules-engine';
import { applyMovement, movementState } from './combatEngine.js';
import type { RoomCombatState } from './combatTypes.js';

type ToolOutcome = ReturnType<typeof execute>;
type Move = { pending: unknown[]; state: Parameters<typeof applyMovement>[2] };
const fail = (error: string, hint: string) =>
  ({ ok: false, error, hint, events: [] }) as unknown as ToolOutcome;

/** Handle of an engine-issued area option, valid only while `expiresTurn` is the open turn. */
export type RoomOptionHandles = NonNullable<RoomCombatState['optionHandles']>;

export const roomTurnKey = (room: RoomCombatState) =>
  room.turnId ?? `r${room.combat.round}:${room.combat.activeEntityId}`;

/** Spend a used area handle (ADR-022 §2.2: single-use); other handles stay. */
export function consumeOptionHandle(
  room: RoomCombatState,
  ref: string,
): RoomCombatState {
  if (!room.optionHandles?.[ref]) return room;
  const rest = { ...room.optionHandles };
  delete rest[ref];
  return { ...room, optionHandles: rest };
}

/**
 * `move_to` / `suggest_area_target` against the authoritative Room combat state. Pure: the
 * returned room differs from the input only when the engine accepted the call, so a rejected
 * call cannot mutate anything.
 */
export function runCombatMapTool(
  room: RoomCombatState,
  call: { name: 'move_to' | 'suggest_area_target'; args: unknown },
  env: {
    catalog: Catalog;
    actors: Readonly<Record<string, CharacterInput>>;
    now?: number;
  },
): { result: ToolOutcome; room: RoomCombatState } {
  const reject = (error: string, hint: string) => ({
    result: fail(error, hint),
    room,
  });
  const active = room.combat.activeEntityId;
  if (room.ended || !active)
    return reject('not-in-combat', 'There is no open combat turn.');
  if (room.pendingReaction)
    return reject(
      'illegal-transition',
      'A reaction is waiting for an answer; wait for it to resolve.',
    );
  const turnId = roomTurnKey(room);
  const live = room.entities.filter((e) => e.hp > 0 && !e.fled);
  const byId = new Map(room.entities.map((e) => [e.id, e]));
  const moveState = movementState(room, active);
  const entities = moveState.entities
    .filter((e) => live.some((l) => l.id === e.id))
    .map((e) => {
      const source = byId.get(e.id)!;
      return {
        ...e,
        name: source.name,
        abilities: source.abilities,
        ...(source.hidden ? { hidden: true } : {}),
      };
    });
  const resources = Object.fromEntries(
    Object.entries(room.combat.resources).map(([id, r]) => [
      id,
      {
        action: r.action,
        bonusAction: r.bonusAction,
        movementLeft: r.movementRemaining,
        reaction: r.reaction,
      },
    ]),
  );
  const base = {
    map: room.map,
    actors: env.actors,
    entities,
    resources,
    hp: moveState.hp,
    turnActorId: active,
    turnId,
    catalog: env.catalog,
  } as unknown as ToolExecutorState;
  const args = call.args as Record<string, unknown> | undefined;

  if (call.name === 'move_to') {
    // A hidden entity is not a nameable destination (ADR-034 §3).
    const ref = args?.targetRef;
    const unknownDestination = () =>
      reject(
        'unreachable',
        `No entity, marker, feature, or current option matches ${String(ref)}.`,
      );
    if (typeof ref === 'string' && byId.get(ref)?.hidden)
      return unknownDestination();
    const result = execute(base, call, room.seed ?? 1);
    if (!result.ok) return { result, room };
    const moved = (result.value as { state: Move['state']; pending: unknown[] })
      .state;
    const pending = (result.value as Move).pending as {
      hostileId: string;
    }[];
    // Refused until M4-6d: the reaction lifecycle (ADR-018) is not wired to DM tools yet.
    // Decide from visible blockers only: a hidden hostile must not change the reply (ADR-034 §3).
    if (pending.length) {
      if (!pending.some((p) => !byId.get(p.hostileId)?.hidden))
        return unknownDestination();
      return reject(
        'unreachable',
        'That route would provoke an opportunity attack; choose a destination that avoids enemy reach.',
      );
    }
    const next = applyMovement(room, active, moved, [], env.now ?? 0);
    return { result, room: { ...next, phase: room.phase } };
  }

  const result = execute(
    {
      ...base,
      casters: env.actors,
      spells: Object.values(env.actors).flatMap((c) =>
        [...c.spellsKnown, ...c.spellsPrepared].flatMap((id) => {
          const template = env.catalog.get('spell', id)?.template;
          return template
            ? [
                {
                  id,
                  template: {
                    shape: template.shape,
                    size: template.size,
                    width: template.width,
                  },
                },
              ]
            : [];
        }),
      ),
    } as ToolExecutorState,
    call,
    room.seed ?? 1,
  );
  if (!result.ok) return { result, room };
  const options = (
    result.value as {
      options: {
        optionId: string;
        anchor: { x: number; y: number };
        affected: { id: string }[];
      }[];
    }
  ).options;
  const kept = Object.fromEntries(
    Object.entries(room.optionHandles ?? {}).filter(
      ([, h]) => h.expiresTurn === turnId,
    ),
  );
  const issued = Object.fromEntries(
    options.map((o) => [
      o.optionId,
      {
        pos: o.anchor,
        expiresTurn: turnId,
        affected: o.affected.map((a) => a.id),
      },
    ]),
  );
  return { result, room: { ...room, optionHandles: { ...kept, ...issued } } };
}
