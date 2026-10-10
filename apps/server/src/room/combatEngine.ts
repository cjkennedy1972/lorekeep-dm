import {
  monsterPolicy,
  moveAlong,
  resolveMonsterAttack,
  resolveReaction,
  type MovementCommandState,
  type PendingReaction,
} from '@game/rules-engine';
import type { GridPos } from '@game/schema';
import {
  REACTION_TIMEOUT_MS,
  type CombatCommandError,
  type CombatEntity,
  type CombatTransition,
  type RoomCombatState,
} from './combatTypes.js';

type Ev = Record<string, unknown>;
const nextSeed = (seed: number) => (seed + 0x9e3779b9) >>> 0;
const alive = (e: CombatEntity) => e.hp > 0 && !e.fled;
const isParty = (e: CombatEntity) => e.team === 'party';
const meleeAttack = (e: CombatEntity) =>
  e.attacks?.find((a) => !a.range) ?? e.attacks?.[0];

/** Engine movement state for one mover; hostile reactors carry the opportunity attack they would make. */
export function movementState(
  state: RoomCombatState,
  moverId: string,
): MovementCommandState {
  const mover = state.entities.find((e) => e.id === moverId);
  return {
    map: state.map,
    entities: state.entities.map((e) => {
      const weapon = meleeAttack(e);
      return {
        id: e.id,
        pos: e.pos,
        size: e.size,
        team: e.team,
        hp: e.hp,
        kind: e.kind === 'character' ? ('pc' as const) : ('monster' as const),
        ac: e.ac,
        reachFt: weapon?.reachFt ?? 5,
        reaction: alive(e) && (state.combat.resources[e.id]?.reaction ?? true),
        ...(weapon
          ? {
              opportunityAttack: {
                seed: state.seed ?? 1,
                attackId: weapon.id,
                attackBonus: weapon.attackBonus,
                damage: weapon.damage,
                damageType: weapon.damageType,
                targetAc: mover?.ac ?? 10,
              },
            }
          : {}),
      };
    }),
    resources: Object.fromEntries(
      Object.entries(state.combat.resources).map(([id, r]) => [
        id,
        { movementLeft: r.movementRemaining, reaction: r.reaction },
      ]),
    ),
    hp: Object.fromEntries(state.entities.map((e) => [e.id, e.hp])),
    pendingReactions: state.engineReactions ?? {},
  };
}

/** Fold an engine movement/reaction result back into the Room state and (re)issue the reaction prompt. */
export function applyMovement(
  state: RoomCombatState,
  moverId: string,
  moved: MovementCommandState,
  pending: readonly PendingReaction[],
  now: number,
): RoomCombatState {
  const resources = { ...state.combat.resources };
  for (const [id, r] of Object.entries(resources)) {
    const left = moved.resources?.[id]?.movementLeft;
    const spent = moved.reactions?.[id] === false;
    resources[id] = {
      ...r,
      ...(id === moverId && left !== undefined
        ? { movementRemaining: left }
        : {}),
      ...(spent ? { reaction: false } : {}),
    };
  }
  const first = [...pending].sort((a, b) =>
    a.reactionId.localeCompare(b.reactionId),
  )[0];
  const rest = { ...state };
  delete rest.pendingReaction;
  delete rest.engineReactions;
  return {
    ...rest,
    entities: state.entities.map((e) => {
      const live = moved.entities.find((item) => item.id === e.id);
      return live
        ? { ...e, pos: { ...live.pos }, hp: moved.hp?.[e.id] ?? live.hp }
        : e;
    }),
    combat: { ...state.combat, resources },
    ...(first
      ? {
          engineReactions: moved.pendingReactions ?? {},
          pendingReaction: {
            reactionId: first.reactionId,
            entityId: first.hostileId,
            trigger: 'opportunityAttack',
            moverId: first.moverId,
            deadlineAt: now + REACTION_TIMEOUT_MS,
          },
        }
      : {}),
  };
}

/** Why combat is over, or null while both sides still have someone standing. */
export function combatOutcome(state: RoomCombatState): string | null {
  const party = state.entities.filter(isParty);
  const enemies = state.entities.filter((e) => !isParty(e));
  if (party.length && party.every((e) => e.hp <= 0)) return 'party-defeated';
  if (enemies.length && enemies.every((e) => !alive(e)))
    return enemies.every((e) => e.hp <= 0) ? 'party-victory' : 'enemies-fled';
  return null;
}
/** Close combat when the rules say so; otherwise return the state unchanged. */
export function settle(state: RoomCombatState): CombatTransition {
  const outcome = combatOutcome(state);
  if (!outcome || state.ended) return { state, events: [] };
  const rest = { ...state };
  delete rest.pendingReaction;
  delete rest.engineReactions;
  return {
    state: {
      ...rest,
      ended: { outcome },
      combat: { ...state.combat, activeEntityId: null },
    },
    events: [{ type: 'CombatEnded', outcome, xp: 0 }],
  };
}

/** Rotate to the next living combatant, refreshing their turn resources. */
export function advanceTurn(state: RoomCombatState): CombatTransition {
  const order = state.combat.initiative;
  const current = order.findIndex(
    (item) => item.entityId === state.combat.activeEntityId,
  );
  const events: Ev[] = [];
  if (state.combat.activeEntityId)
    events.push({ type: 'TurnEnded', entityId: state.combat.activeEntityId });
  for (let step = 1; step <= order.length; step++) {
    const raw = current + step;
    const index = raw % order.length;
    const round =
      state.combat.round + (current >= 0 && raw >= order.length ? 1 : 0);
    const nextId = order[index]!.entityId;
    const entity = state.entities.find((e) => e.id === nextId);
    if (!entity || !alive(entity)) continue;
    events.push({ type: 'TurnStarted', entityId: nextId, round });
    return {
      state: {
        ...state,
        combat: {
          ...state.combat,
          round,
          activeEntityId: nextId,
          resources: {
            ...state.combat.resources,
            [nextId]: {
              action: true,
              bonusAction: true,
              reaction: true,
              movementRemaining: entity.speed ?? 30,
            },
          },
        },
      },
      events,
    };
  }
  return { state, events };
}

export function withHp(state: RoomCombatState, events: readonly Ev[]) {
  let entities = state.entities;
  let concentration = state.concentration;
  for (const event of events)
    if (event.type === 'HpChanged') {
      entities = entities.map((e) =>
        e.id === event.entityId ? { ...e, hp: Number(event.to) } : e,
      );
      if (
        Number(event.to) < Number(event.from) &&
        concentration?.[String(event.entityId)]
      )
        concentration = { ...concentration, [String(event.entityId)]: null };
    }
  return { ...state, entities, ...(concentration ? { concentration } : {}) };
}
const combatant = (
  e: CombatEntity,
  speed: number,
  team = e.team,
): Parameters<typeof monsterPolicy>[0]['entities'][number] => {
  const weapon = meleeAttack(e);
  return {
    id: e.id,
    team,
    pos: e.pos,
    size: e.size,
    hp: e.hp,
    ac: e.ac ?? 10,
    speed,
    attackBonus: weapon?.attackBonus ?? 0,
    damage: weapon?.damage ?? '1d4',
  };
};

/** One monster's turn by the scripted policy; nothing here consults an LLM. */
function monsterTurn(
  start: RoomCombatState,
  now: number,
): CombatTransition & { paused?: boolean } {
  const id = start.combat.activeEntityId!;
  let state = start;
  const events: Ev[] = [];
  for (let step = 0; step < 4; step++) {
    const monster = state.entities.find((e) => e.id === id)!;
    const resources = state.combat.resources[id]!;
    const fleeing = monster.hp * 4 <= monster.maxHp;
    const decision = monsterPolicy({
      map: state.map,
      entities: state.entities
        .filter((e) => e.hp > 0 && !e.fled)
        .map((e) =>
          // the policy's attack resolver tags party members as 'pc' targets
          combatant(
            e,
            e.id === id ? resources.movementRemaining : (e.speed ?? 30),
            e.kind === 'character' ? 'pc' : e.team,
          ),
        ),
      monsterId: id,
      fleeing,
    });
    events.push({
      type: 'MonsterPolicy',
      monsterId: id,
      decision: decision.kind,
    });
    if (decision.kind === 'hold') break;
    if (decision.kind === 'attack') {
      if (!resources.action) break;
      const target = state.entities.find((e) => e.id === decision.targetId)!;
      const result = resolveMonsterAttack(
        combatant(monster, resources.movementRemaining),
        combatant(target, 0, target.kind === 'character' ? 'pc' : target.team),
        state.seed ?? 1,
      );
      if ('error' in result) break;
      events.push(...(result.events as Ev[]), {
        type: 'ActionSpent',
        entityId: id,
      });
      state = withHp(
        {
          ...state,
          seed: result.rng,
          combat: {
            ...state.combat,
            resources: {
              ...state.combat.resources,
              [id]: { ...resources, action: false },
            },
          },
        },
        result.events as Ev[],
      );
      continue;
    }
    // approach / flee: engine movement, so cost, terrain and opportunity attacks all apply
    const moved = moveAlong(
      movementState(state, id),
      id,
      decision.path as GridPos[],
      decision.kind === 'flee' ? 'forced' : 'normal',
    );
    if ('error' in moved) break;
    events.push(...(moved.events as unknown as Ev[]));
    state = applyMovement(state, id, moved.state, moved.pending, now);
    if (decision.kind === 'flee' && !moved.pending.length)
      state = {
        ...state,
        entities: state.entities.map((e) =>
          e.id === id ? { ...e, fled: true } : e,
        ),
      };
    if (state.pendingReaction) return { state, events, paused: true };
    if (decision.kind === 'flee') break;
  }
  return { state, events };
}

/** Play every consecutive monster turn until a party member is up, a reaction needs an answer, or combat ends. */
export function runMonsters(
  start: RoomCombatState,
  now: number,
): CombatTransition {
  let state = start;
  const events: Ev[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const ended = settle(state);
    if (ended.events.length)
      return { state: ended.state, events: [...events, ...ended.events] };
    if (state.ended || state.pendingReaction) break;
    const active = state.entities.find(
      (e) => e.id === state.combat.activeEntityId,
    );
    if (!active) break;
    if (isParty(active) && alive(active)) break;
    if (!alive(active)) {
      const next = advanceTurn(state);
      events.push(...next.events);
      if (next.state === state) break;
      state = next.state;
      continue;
    }
    const turn = monsterTurn(state, now);
    events.push(...turn.events);
    state = turn.state;
    if (turn.paused) break;
    const closing = settle(state);
    if (closing.events.length)
      return { state: closing.state, events: [...events, ...closing.events] };
    const next = advanceTurn(state);
    events.push(...next.events);
    state = next.state;
  }
  return { state, events };
}

/** The answer to a prompt, from the party member whose reaction it is or whose movement provoked it. */
export function answerReaction(
  state: RoomCombatState,
  actorId: string,
  reactionId: string,
  choice: 'take' | 'decline',
  now: number,
): CombatTransition | CombatCommandError {
  const prompt = state.pendingReaction;
  if (!prompt || prompt.reactionId !== reactionId)
    return {
      code: 'COMMAND_REJECTED',
      message: 'There is no such reaction waiting for an answer.',
    };
  if (actorId !== prompt.entityId && actorId !== prompt.moverId)
    return {
      code: 'COMMAND_REJECTED',
      message: 'That reaction is not yours to answer.',
    };
  const result = resolveReaction(
    {
      ...movementState(state, prompt.moverId),
      pendingReactions: state.engineReactions,
    },
    reactionId,
    choice,
  );
  if ('error' in result)
    return { code: 'COMMAND_REJECTED', message: result.hint };
  const events = result.events as unknown as Ev[];
  const next = applyMovement(
    { ...state, seed: nextSeed(state.seed ?? 1) },
    prompt.moverId,
    result.state,
    result.pending,
    now,
  );
  const settled = settle(next);
  if (settled.events.length)
    return { state: settled.state, events: [...events, ...settled.events] };
  if (next.pendingReaction) return { state: next, events };
  const rest = runMonsters(next, now);
  return { state: rest.state, events: [...events, ...rest.events] };
}

/** The 15 s deadline passed unanswered: decline on the table's behalf. */
export function expireReaction(
  state: RoomCombatState,
  now: number,
): CombatTransition | null {
  const prompt = state.pendingReaction;
  if (!prompt || now < prompt.deadlineAt) return null;
  if (!state.engineReactions?.[prompt.reactionId]) {
    const next = { ...state };
    delete next.pendingReaction;
    return {
      state: next,
      events: [
        {
          type: 'ReactionResolved',
          entityId: prompt.entityId,
          used: false,
          reactionId: prompt.reactionId,
        },
      ],
    };
  }
  const result = answerReaction(
    state,
    prompt.moverId,
    prompt.reactionId,
    'decline',
    now,
  );
  return 'code' in result ? null : result;
}
