import type { GridPos, ServerMessage } from '@game/schema';
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
  declineReaction,
  expireReaction,
  movementState,
  runMonsters,
  settle,
  withHp,
} from './combatEngine.js';
import {
  reconcileCombat,
  type PartyBindings,
  type Reconciled,
} from './combatBootstrap.js';
import { areaOptions, castCommand } from './combatSpell.js';
import {
  type CombatCommandError,
  type CombatContext,
  type CombatTransition,
  type ReactionDeclineCause,
  type RoomCombatState,
  promptIdOf,
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
  reconcile(
    game: Record<string, unknown>,
    now?: number,
    party?: PartyBindings,
  ): Reconciled | null;
  /** Auto-decline a reaction prompt whose deadline passed. */
  expire(state: RoomCombatState, now: number): CombatTransition | null;
  /** Close the open prompt as declined by the table (party combat: ReactionDeclined{cause}). */
  decline(
    state: RoomCombatState,
    cause: ReactionDeclineCause,
    now: number,
  ): CombatTransition | null;
};

export function hiddenEntityIds(
  state: Pick<RoomCombatState, 'entities'>,
): Set<string> {
  return new Set(
    (state.entities ?? [])
      .filter((entity) => entity.hidden)
      .map((entity) => entity.id),
  );
}

const NON_PUBLIC_PC_FIELDS = [
  'ac',
  'speed',
  'abilities',
  'saves',
  'attacks',
] as const;

/**
 * Per-viewer projection (ADR-034 §3, ADR-035). A hidden entity is removed outright from
 * everything a viewer receives (entities, initiative, resources, reaction prompt, dodge,
 * concentration) unless the viewer controls it: no pos, no hp, no existence. Another seat's
 * character keeps the ADR-035 public stats (current and max party HP; no AC, speed, abilities,
 * saves, attacks). Non-party entities expose only coarse HP state. Authoritative
 * server state is untouched; this only shapes what is serialized to a client.
 */
function hpStateFor(hp: number, maxHp: number): 'healthy' | 'wounded' | 'down' {
  return hp <= 0
    ? 'down'
    : hp / Math.max(1, maxHp) > 0.5
      ? 'healthy'
      : 'wounded';
}

export function projectCombatForViewer<T extends RoomCombatState>(
  full: T,
  controlled: ReadonlySet<string> = new Set(),
): T {
  // Engine-only: `seed` predicts every future roll (hidden monsters' too), engineReactions is a server continuation.
  const state = { ...full };
  delete state.seed;
  delete state.engineReactions;
  // Legacy/partial persisted rooms carry no entities or tracker; nothing to project.
  if (!Array.isArray(state.entities) || !state.combat) return state;
  const hidden = new Set(
    state.entities
      .filter((entity) => entity.hidden && !controlled.has(entity.id))
      .map((entity) => entity.id),
  );
  // Absent active entity means "list head" everywhere; only a hidden actor yields null (clients rely on this).
  const head =
    state.combat.activeEntityId ??
    state.combat.initiative?.[0]?.entityId ??
    null;
  const { pendingReaction, dodging, concentration, ...rest } = state;
  const active = head;
  return {
    ...rest,
    entities: state.entities
      .filter((entity) => !hidden.has(entity.id))
      .map((entity) => {
        if (controlled.has(entity.id)) return entity;
        if (entity.kind === 'character') {
          // ADR-034 §6 makes both current and max party HP public. Other sheet
          // stats remain private to the controlling seat.
          const pub: Record<string, unknown> = { ...entity };
          for (const key of NON_PUBLIC_PC_FIELDS) delete pub[key];
          if (entity.team !== 'party') {
            pub.hpState = hpStateFor(entity.hp, entity.maxHp);
            delete pub.hp;
            delete pub.maxHp;
          } else {
            pub.hpState = hpStateFor(entity.hp, entity.maxHp);
          }
          return pub as typeof entity;
        }
        const pub: Record<string, unknown> = { ...entity };
        if (entity.team !== 'party') {
          // Non-party HP is intentionally coarse in the tracker. Keep the same
          // contract in combatRoom and its checkpoints/reconnect projection.
          pub.hpState = hpStateFor(entity.hp, entity.maxHp);
          delete pub.hp;
          delete pub.maxHp;
        } else {
          pub.hpState = hpStateFor(entity.hp, entity.maxHp);
        }
        return pub as typeof entity;
      }),
    combat: {
      ...state.combat,
      activeEntityId: active && hidden.has(active) ? null : active,
      initiative: (state.combat.initiative ?? []).filter(
        (item) => !hidden.has(item.entityId),
      ),
      resources: Object.fromEntries(
        Object.entries(state.combat.resources ?? {}).filter(
          ([id]) => !hidden.has(id),
        ),
      ),
    },
    ...(pendingReaction && !hidden.has(pendingReaction.entityId)
      ? { pendingReaction }
      : {}),
    ...(dodging ? { dodging: dodging.filter((id) => !hidden.has(id)) } : {}),
    ...(concentration
      ? {
          concentration: Object.fromEntries(
            Object.entries(concentration).filter(([id]) => !hidden.has(id)),
          ),
        }
      : {}),
  } as T;
}

/** Mechanical opening summary for moderation-held narration (ADR-038). Project first so hidden entities cannot leak. */
export function combatOpeningSummary(
  full: RoomCombatState,
  controlled: ReadonlySet<string> = new Set(),
): string {
  const state = projectCombatForViewer(full, controlled);
  const byId = new Map(state.entities.map((entity) => [entity.id, entity]));
  const lines = ['Combat begins.'];
  for (const [index, initiative] of (state.combat.initiative ?? []).entries()) {
    const entity = byId.get(initiative.entityId);
    if (!entity) continue;
    lines.push(
      `${index + 1}. ${entity.name ?? 'Combatant'} (initiative ${initiative.total}) at ${entity.pos.x}, ${entity.pos.y}.`,
    );
  }
  return lines.join(' ');
}
/** Party combat replaces the M2 ReactionAvailable/ReactionResolved events with the prompt lifecycle (no dual emission). */
const LEGACY_REACTION_EVENTS = new Set([
  'ReactionAvailable',
  'ReactionResolved',
]);
const withoutLegacyReactionEvents = <
  T extends { events: Record<string, unknown>[] },
>(
  result: T,
  promptEvents: boolean | undefined,
): T =>
  promptEvents
    ? {
        ...result,
        events: result.events.filter(
          (event) => !LEGACY_REACTION_EVENTS.has(String(event.type)),
        ),
      }
    : result;

/** Stable client projection; exact enemy HP is private while the active token always matches initiative. */
export function combatTracker(
  full: RoomCombatState,
  controlled?: ReadonlySet<string>,
) {
  const state = projectCombatForViewer(full, controlled);
  const fullActive =
    full.combat.activeEntityId ?? full.combat.initiative[0]?.entityId ?? null;
  const visible = new Set(state.combat.initiative.map((i) => i.entityId));
  // No fallback: while an entity hidden from this viewer acts, no visible token is active.
  const active =
    fullActive !== null && visible.has(fullActive) ? fullActive : null;
  const activeIndex = Math.max(
    0,
    full.combat.initiative.findIndex((item) => item.entityId === fullActive),
  );
  const ordered = [
    ...full.combat.initiative.slice(activeIndex),
    ...full.combat.initiative.slice(0, activeIndex),
  ].filter((item) => visible.has(item.entityId));
  return {
    round: state.combat.round,
    initiative: ordered.map(({ entityId, total }) => ({ entityId, total })),
    activeEntityId: active,
    entities: state.entities.map((entity) => {
      const { id, kind, team, hp, maxHp, pos, fled } = entity;
      const existingHpState = (entity as typeof entity & { hpState?: string })
        .hpState;
      return {
        id,
        kind,
        team,
        ...(team === 'party' && typeof hp === 'number' ? { hp } : {}),
        ...(team === 'party' && typeof maxHp === 'number' ? { maxHp } : {}),
        hpState: existingHpState ?? hpStateFor(hp, maxHp),
        pos,
        ...(fled ? { fled } : {}),
      };
    }),
    resources: state.combat.resources,
    ...(state.ended ? { ended: state.ended } : {}),
  };
}

export const ATTACK_REJECTED = 'That attack is not currently available.';

const attackAdmissionReject = (
  result: CombatCommandError,
  reason: NonNullable<CombatCommandError['attackRejectReason']>,
): CombatCommandError => ({
  ...result,
  message: ATTACK_REJECTED,
  attackRejectReason: reason,
});

const attackAdmissionReason = (
  code: CombatCommandError['code'],
): NonNullable<CombatCommandError['attackRejectReason']> => {
  switch (code) {
    case 'narration-in-progress':
      return 'narration_in_progress';
    case 'move-in-progress':
      return 'move_in_progress';
    case 'reaction-window-open':
      return 'reaction_window_open';
    case 'not-your-turn':
    case 'COMMAND_REJECTED':
      return 'not_your_turn';
  }
};

const reject = (
  message: string,
  attackRejectReason?: CombatCommandError['attackRejectReason'],
): CombatCommandError => ({
  code: 'COMMAND_REJECTED',
  message,
  ...(attackRejectReason ? { attackRejectReason } : {}),
});

const rejectAdmission = (
  code: Extract<
    CombatCommandError['code'],
    | 'not-your-turn'
    | 'move-in-progress'
    | 'reaction-window-open'
    | 'narration-in-progress'
  >,
): CombatCommandError => ({
  code,
  message: {
    'not-your-turn': 'It is not your turn.',
    'move-in-progress': 'Your movement is still resolving.',
    'reaction-window-open': 'Resolve the open reaction first.',
    'narration-in-progress': 'The DM is narrating this turn.',
  }[code],
});

function admissionError(
  state: RoomCombatState,
  actorId: string,
  command: CombatCommand['payload'],
): CombatCommandError | null {
  const active =
    state.combat.activeEntityId ?? state.combat.initiative[0]?.entityId;
  const phase = state.pendingReaction
    ? 'reaction-pending'
    : (state.phase ?? 'awaiting-command');
  const isActive = actorId === active;
  // Room derives actorId from the authenticated seat's server-side entity binding.
  // Only the reactor's controller (entityId), never the mover, may answer.
  const isReactor = actorId === state.pendingReaction?.entityId;

  // Authorization precedes phase: a non-active party seat gets not-your-turn
  // even during reaction-pending, before any phase-specific rejection can reveal it.
  // OOC chat does not enter this admission path; Room.commitChat accepts it independently of combat phase.
  if (command.command === 'reaction' && !isReactor)
    return rejectAdmission('not-your-turn');
  if (command.command !== 'reaction' && !isActive)
    return rejectAdmission('not-your-turn');
  if (phase === 'awaiting-command')
    return command.command === 'reaction'
      ? rejectAdmission('reaction-window-open')
      : null;
  if (phase === 'moving')
    return rejectAdmission(
      command.command === 'reaction'
        ? 'reaction-window-open'
        : 'move-in-progress',
    );
  if (phase === 'reaction-pending')
    return command.command === 'reaction' && isReactor
      ? null
      : rejectAdmission('reaction-window-open');
  return rejectAdmission('narration-in-progress');
}

export function createCombatRuntime(
  catalog: Catalog = defaultCatalog(),
): CombatRuntime {
  const optionsState = (
    state: RoomCombatState,
    actorId: string,
    ctx?: CombatContext,
  ) => ({
    map: state.map,
    entities: state.entities.filter(
      (item) =>
        !item.fled && (!item.hidden || ctx?.controlledEntityIds?.has(item.id)),
    ),
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
  const base: CombatRuntime = {
    preview(state, actorId, ctx) {
      if (!state.entities.some((item) => item.id === actorId))
        return { actions: [] };
      return legalOptions(
        optionsState(state, actorId, ctx) as Parameters<typeof legalOptions>[0],
        actorId,
      );
    },
    reconcile(game, now = Date.now(), party) {
      const rec = reconcileCombat(game, catalog, now, party);
      return rec
        ? withoutLegacyReactionEvents(
            rec,
            !!party && !!rec.gameState.combatRoom,
          )
        : rec;
    },
    expire(state, now) {
      const result = expireReaction(state, now);
      return result && withoutLegacyReactionEvents(result, state.promptEvents);
    },
    decline: declineReaction,
    execute(state, actorId, command, ctx) {
      const now = ctx?.now ?? Date.now();
      if (state.ended) {
        const error = reject('Combat is over.');
        return command.command === 'attack'
          ? attackAdmissionReject(error, 'combat_ended')
          : error;
      }
      const denied = admissionError(state, actorId, command);
      if (denied)
        return command.command === 'attack'
          ? attackAdmissionReject(denied, attackAdmissionReason(denied.code))
          : denied;
      if (command.command === 'reaction')
        return answerReaction(
          state,
          actorId,
          command.reactionId,
          command.choice,
          now,
        );
      const active =
        state.combat.activeEntityId ?? state.combat.initiative[0]?.entityId;
      if (actorId !== active) {
        const error = rejectAdmission('not-your-turn');
        return command.command === 'attack'
          ? attackAdmissionReject(error, attackAdmissionReason(error.code))
          : error;
      }
      if (command.command === 'options') {
        const preview = runtime.preview(state, actorId, ctx) as Record<
          string,
          unknown
        >;
        const areas = (ctx?.character?.spellsPrepared ?? []).flatMap((id) =>
          areaOptions(
            state,
            actorId,
            id,
            catalog,
            ctx?.controlledEntityIds,
          ).map((option) => ({
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
          ctx?.controlledEntityIds,
        );
        if ('code' in cast) return cast;
        return cast;
      }
      const resource = state.combat.resources[actorId];
      if (command.command === 'attack') {
        const attacker = state.entities.find((item) => item.id === actorId);
        const target = state.entities.find(
          (item) =>
            item.id === command.targetId &&
            (!item.hidden || ctx?.controlledEntityIds?.has(item.id)),
        );
        const weapon = attacker?.attacks?.find(
          (item) => item.id === command.attackId,
        );
        if (!attacker) return reject(ATTACK_REJECTED, 'attacker_missing');
        if (!target) return reject(ATTACK_REJECTED, 'target_unavailable');
        if (!weapon) return reject(ATTACK_REJECTED, 'weapon_missing');
        if (!resource?.action)
          return reject(ATTACK_REJECTED, 'action_unavailable');
        if (target.hp <= 0) return reject(ATTACK_REJECTED, 'target_dead');
        if (target.fled) return reject(ATTACK_REJECTED, 'target_fled');
        const result = attack({
          attackerId: actorId,
          targetId: target.id,
          attackId: weapon.id,
          seed: state.seed ?? 1,
          attackBonus: weapon.attackBonus,
          ...(state.dodging?.includes(target.id)
            ? { mode: 'disadvantage' as const }
            : {}),
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
          return reject(ATTACK_REJECTED, 'illegal_range_or_line_of_sight');
        const resolvedEvents = result.events.map((event) => {
          if (event.type !== 'RollEvent') return event;
          if (event.kind === 'attack')
            return {
              ...event,
              targetId: target.id,
              targetAc: target.ac ?? 10,
              hit: result.hit,
            };
          if (event.kind === 'damage') {
            const hp = result.events.find(
              (candidate) =>
                candidate.type === 'HpChanged' &&
                (candidate as unknown as Record<string, unknown>).entityId ===
                  target.id,
            );
            return {
              ...event,
              targetId: target.id,
              ...(hp &&
              typeof (hp as unknown as Record<string, unknown>).damage ===
                'number'
                ? {
                    publicDamage: (hp as unknown as Record<string, unknown>)
                      .damage,
                  }
                : {}),
            };
          }
          return event;
        });
        const revealed = attacker.hidden
          ? [{ type: 'EntityRevealed', entityId: attacker.id, cause: 'attack' }]
          : [];
        const hit = withHp(
          {
            ...state,
            entities: attacker.hidden
              ? state.entities.map((item) =>
                  item.id === attacker.id ? { ...item, hidden: false } : item,
                )
              : state.entities,
            seed: result.rng,
            combat: {
              ...state.combat,
              resources: {
                ...state.combat.resources,
                [actorId]: { ...resource, action: false },
              },
            },
          },
          resolvedEvents,
        );
        const closing = settle(hit.state);
        return {
          state: closing.state,
          events: [
            ...revealed,
            ...resolvedEvents,
            ...hit.events,
            { type: 'ActionSpent', entityId: actorId },
            ...closing.events,
          ],
        };
      }
      if (command.command === 'dodge') {
        const resources = state.combat.resources[actorId];
        if (!resources?.action)
          return reject('Dodge is unavailable this turn.');
        return {
          state: {
            ...state,
            dodging: [...new Set([...(state.dodging ?? []), actorId])],
            combat: {
              ...state.combat,
              resources: {
                ...state.combat.resources,
                [actorId]: { ...resources, action: false },
              },
            },
          },
          events: [{ type: 'DodgeDeclared', entityId: actorId }],
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
        // Match the viewer's preview: hidden, uncontrolled entities do not participate
        // in path planning, so a listed destination through one resolves as a bump.
        const routeState = {
          ...mv,
          entities: mv.entities.filter(
            (item) => !item.hidden || ctx?.controlledEntityIds?.has(item.id),
          ),
        };
        let route = path(routeState, actorId, command.destination);
        let bumpAttempt = false;
        const hiddenOccupant = state.entities.find(
          (other) =>
            other.id !== actorId &&
            other.hidden &&
            other.team !== entity.team &&
            command.destination.x < other.pos.x + other.size &&
            command.destination.x + entity.size > other.pos.x &&
            command.destination.y < other.pos.y + other.size &&
            command.destination.y + entity.size > other.pos.y,
        );
        if (hiddenOccupant) {
          const adjacent: GridPos[] = [];
          for (
            let y = hiddenOccupant.pos.y - 1;
            y <= hiddenOccupant.pos.y + hiddenOccupant.size;
            y++
          )
            for (
              let x = hiddenOccupant.pos.x - 1;
              x <= hiddenOccupant.pos.x + hiddenOccupant.size;
              x++
            ) {
              if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h)
                continue;
              const candidate = path(mv, actorId, { x, y });
              if ('path' in candidate) adjacent.push({ x, y });
            }
          const choices = adjacent
            .map((pos) => path(mv, actorId, pos))
            .filter((item) => 'path' in item);
          choices.sort(
            (a, b) =>
              ('cost' in a ? a.cost : Infinity) -
              ('cost' in b ? b.cost : Infinity),
          );
          const approach = choices[0];
          if (approach && 'path' in approach) {
            route = {
              path: [...approach.path, command.destination],
              cost: approach.cost,
            };
            bumpAttempt = true;
          }
        }
        if ('error' in route)
          return reject('That destination is not reachable.');
        const moved = moveAlong(mv, actorId, route.path, 'normal');
        if ('error' in moved) return reject(moved.hint);
        const next = applyMovement(
          { ...state, phase: 'moving' },
          actorId,
          moved.state,
          moved.pending,
          now,
        );
        // One EntityMoved for the whole path unless a reaction interrupted it.
        const engineEvents = moved.events as unknown as Record<
          string,
          unknown
        >[];
        const movementRevealed = moved.events.some(
          (event) => event.type === 'EntityRevealed',
        );
        const events: Record<string, unknown>[] =
          moved.pending.length || bumpAttempt || movementRevealed
            ? [
                { type: 'MoveStarted', entityId: actorId, path: route.path },
                ...engineEvents,
                ...(!moved.pending.length
                  ? [
                      {
                        type: 'MoveEnded',
                        entityId: actorId,
                        reason:
                          moved.movementEnd ??
                          (bumpAttempt ? 'blocked' : 'complete'),
                      },
                    ]
                  : []),
              ]
            : [
                { type: 'MoveStarted', entityId: actorId, path: route.path },
                {
                  type: 'EntityMoved',
                  entityId: actorId,
                  path: route.path,
                  cost: route.cost,
                },
                {
                  type: 'MoveEnded',
                  entityId: actorId,
                  reason: moved.movementEnd ?? 'complete',
                },
              ];
        return { state: next, events };
      }
      return reject(
        'That combat command is not configured for this encounter.',
      );
    },
  };
  const runtime: CombatRuntime = {
    ...base,
    execute(state, actorId, command, ctx) {
      const result = base.execute(state, actorId, command, ctx);
      return 'code' in result
        ? result
        : withoutLegacyReactionEvents(result, result.state.promptEvents);
    },
  };
  return runtime;
}

let cached: Catalog | undefined;
function defaultCatalog(): Catalog {
  return (cached ??= loadCatalog());
}

/** Engine events as the wire schema (EngineEventSchema) spells them. */
/**
 * `concealStats`: the roller is a PC the viewer does not control (ADR-035). The natural dice and the total are
 * table-visible; the modifier (attack/save/damage bonus), the weapon or spell name and any constant in the
 * expression are the PC's non-public sheet and are dropped.
 */
export function toWireEvent(
  event: Readonly<Record<string, unknown>>,
  concealStats = false,
  revealAttack = true,
  revealDamage = true,
  publicDamage = true,
): Record<string, unknown> {
  if (event.type === 'SlotSpent' && event.level === undefined)
    return { ...event, level: event.slotLevel };
  if (event.type === 'RollEvent' && event.breakdown) {
    const roll = event.breakdown as RollBreakdown;
    if (event.kind === 'attack' && !revealAttack)
      return {
        type: 'RollEvent',
        actorId: event.entityId,
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
        label: 'attack',
        dice: 'attack roll',
        ...(typeof event.targetId === 'string'
          ? { targetId: event.targetId }
          : {}),
        ...(typeof event.hit === 'boolean' ? { hit: event.hit } : {}),
      };
    if (event.kind === 'damage' && !revealDamage)
      return {
        type: 'RollEvent',
        actorId: event.entityId,
        ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
        label: 'damage',
        dice: 'damage roll',
        ...(typeof event.targetId === 'string'
          ? { targetId: event.targetId }
          : {}),
        ...(publicDamage && Number.isInteger(event.publicDamage)
          ? { damage: event.publicDamage }
          : {}),
      };
    return {
      type: 'RollEvent',
      actorId: event.entityId,
      ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      ...(event.kind === 'attack' && revealAttack ? { breakdown: roll } : {}),
      label: concealStats
        ? String(event.kind)
        : `${String(event.kind)} ${String(event.attackId ?? event.spellId)}`,
      dice: concealStats
        ? (/^\d*d\d+/i.exec(roll.expression)?.[0] ?? roll.expression)
        : roll.expression,
      rolls: roll.dice.filter((die) => die.kept).map((die) => die.value),
      ...(concealStats
        ? {}
        : { modifier: roll.modifiers.reduce((sum, m) => sum + m.value, 0) }),
      total: roll.total,
      ...(event.targetId === undefined ? {} : { targetId: event.targetId }),
      ...(event.hit === undefined ? {} : { hit: event.hit }),
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
  controlled?: ReadonlySet<string>,
  actionId?: string,
): ServerMessage {
  return {
    seq,
    type: 'CombatTracker',
    payload: {
      ...combatTracker(state, controlled),
      ...(actionId ? { commandActionId: actionId } : {}),
    },
  } as ServerMessage;
}
/** The controlling seat's private prompt: trigger, mover and the answers it may give (ADR-033 §3.2). */
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
      reactionId: promptIdOf(reaction),
      timeoutMs: Math.max(0, reaction.deadlineAt - now),
      options: ['take', 'decline'],
      defaultChoice: 'decline',
    },
  } as ServerMessage;
}
/** What every other seat may know about a visible reactor's open window: that it is open and when it ends (ADR-033 §3.1). */
export function reactionOpenMessage(
  seq: number,
  reaction: NonNullable<RoomCombatState['pendingReaction']>,
  now = Date.now(),
): ServerMessage {
  return {
    seq,
    type: 'ReactionPromptOpen',
    payload: {
      reactionId: promptIdOf(reaction),
      reactorEntityId: reaction.entityId,
      deadlineAt: reaction.deadlineAt,
      timeoutMs: Math.max(0, reaction.deadlineAt - now),
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
