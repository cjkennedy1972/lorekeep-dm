import type { Ability, Battlemap, GridPos } from '@game/schema';
import { loadCatalog } from '../catalog/load.js';
import { attack, type AttackEvent } from '../combat/attack.js';
import {
  contestedCheck,
  deathSave,
  freshDeathSaves,
  type DeathSaves,
} from '../combat/checks.js';
import {
  apply as applyCombat,
  emptyCombatState,
  type CombatEvent,
  type CombatState,
} from '../combat/state.js';
import { rollInitiative, startCombat } from '../combat/commands.js';
import {
  applyConditionEvent,
  attackRollMode,
  startTurnWithConditions,
  type ActiveCondition,
  type ConditionEvent,
  type ConditionId,
  type ConditionState,
} from '../combat/conditions.js';
import {
  castSpell,
  concentrationSave,
  type SpellState,
} from '../combat/spells.js';
import { abilityModifier } from '../dice.js';
import { distance, inReach } from '../map/geometry.js';
import {
  moveAlong,
  resolveReaction,
  type MovementCommandState,
} from '../map/movement.js';
import { movementCost } from '../map/reachable.js';
import { path as findPath } from '../map/path.js';
import { nextDie, seedRng, type RngState } from '../rng.js';
import { monsterPolicy } from './policy.js';

export type SimEvent = Record<string, unknown> & { type: string };
export type SimSpec = {
  id: string;
  team: 'pc' | 'foe';
  pos: GridPos;
  size: number;
  hp: number;
  ac: number;
  speed: number;
  abilities: Record<Ability, number>;
  attackBonus: number;
  damage: string;
  damageType: string;
  /** Ranged attack; the entity prefers it when no enemy is within reach. */
  range?: { normalFt: number; longFt: number };
  saveProficiencies?: Ability[];
  /** Level-N caster; slots are `{ '1': 2 }` style maxima. */
  caster?: { classId: string; level: number; slots: Record<string, number> };
  /** Starts the fight already at 0 HP and dying. */
  startsDying?: boolean;
};
export type SimEntity = {
  id: string;
  team: 'pc' | 'foe';
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  abilities: Record<Ability, number>;
  attackBonus: number;
  damage: string;
  damageType: string;
  range?: { normalFt: number; longFt: number };
  saveProficiencies: Ability[];
  caster?: SimSpec['caster'];
  slotsUsed: Record<string, number>;
  conditions: ActiveCondition[];
  status: 'up' | 'dying' | 'stable' | 'dead';
  death: { successes: number; failures: number };
  concentration: string | null;
};
export type SimState = {
  mapId: string;
  entities: SimEntity[];
  doors: Record<string, string>;
  round: number;
  outcome: 'in-progress' | 'CombatEnded';
  reason?: string;
};
export type SimLog = {
  scenario: string;
  seed: number;
  events: SimEvent[];
  finalState: SimState;
};

const edgeKey = (a: GridPos, b: GridPos) => {
  const [p, q] = [a, b].sort((m, n) => m.x - n.x || m.y - n.y);
  return `${p!.x},${p!.y}|${q!.x},${q!.y}`;
};

/** Pure fold: every observable fact in SimState comes from the event log. */
export function reduceSim(state: SimState, event: SimEvent): SimState {
  const patch = (id: unknown, fn: (e: SimEntity) => Partial<SimEntity>) => ({
    ...state,
    entities: state.entities.map((e) => (e.id === id ? { ...e, ...fn(e) } : e)),
  });
  switch (event.type) {
    case 'CombatStarted':
      return {
        mapId: String(event.mapId),
        entities: structuredClone(event.entities as SimEntity[]),
        doors: structuredClone(event.doors as Record<string, string>),
        round: 0,
        outcome: 'in-progress',
      };
    case 'TurnStarted':
      return { ...state, round: Number(event.round) };
    case 'EntityMoved': {
      const path = event.path as GridPos[];
      return patch(event.entityId, () => ({
        pos: { ...path[path.length - 1]! },
      }));
    }
    case 'HpChanged':
      return patch(event.entityId, () => ({ hp: Number(event.to) }));
    case 'EntityDown':
      return patch(event.entityId, () => ({
        status: event.outcome === 'dead' ? 'dead' : 'dying',
        death: { successes: 0, failures: 0 },
      }));
    case 'DeathSave':
      return patch(event.entityId, () => ({
        death: {
          successes: Number(event.successes),
          failures: Number(event.failures),
        },
        status: event.dead
          ? 'dead'
          : event.revived
            ? 'up'
            : event.stable
              ? 'stable'
              : 'dying',
      }));
    case 'ConditionApplied':
    case 'ConditionRemoved':
    case 'ConditionsTicked': {
      const id = String(event.entityId);
      const next = applyConditionEvent(
        Object.fromEntries(state.entities.map((e) => [e.id, e.conditions])),
        event as unknown as ConditionEvent,
      );
      return patch(id, () => ({ conditions: next[id] ?? [] }));
    }
    case 'SlotSpent':
      return patch(event.entityId, (e) => ({
        slotsUsed: {
          ...e.slotsUsed,
          [String(event.slotLevel)]:
            (e.slotsUsed[String(event.slotLevel)] ?? 0) + 1,
        },
      }));
    case 'ConcentrationStarted':
      return patch(event.entityId, () => ({
        concentration: String(event.spellId),
      }));
    case 'ConcentrationDropped':
      return patch(event.entityId, () => ({ concentration: null }));
    case 'DoorOpened':
      return {
        ...state,
        doors: {
          ...state.doors,
          [edgeKey(event.a as GridPos, event.b as GridPos)]: 'open',
        },
      };
    case 'CombatEnded':
      return {
        ...state,
        outcome: 'CombatEnded',
        reason: String(event.reason),
      };
    default:
      return state;
  }
}

/** Rebuild the observable final state from nothing but the event log. */
export function replaySim(events: readonly SimEvent[]): SimState {
  return events.reduce(reduceSim, {
    mapId: '',
    entities: [],
    doors: {},
    round: 0,
    outcome: 'in-progress',
  } as SimState);
}

const catalog = loadCatalog();
const zero = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
export const abilities = (a: Partial<Record<Ability, number>>) => ({
  ...zero,
  ...a,
});
const mod = (e: SimEntity, a: Ability) => abilityModifier(e.abilities[a]);
const profBonus = (e: SimEntity) =>
  e.caster ? 2 + Math.floor(((e.caster.level ?? 1) - 1) / 4) : 2;

export class Sim {
  readonly events: SimEvent[] = [];
  state: SimState;
  rng: RngState;
  map: Battlemap;
  private combat: CombatState = emptyCombatState();
  private movementLeft: Record<string, number> = {};
  private reaction: Record<string, boolean> = {};

  constructor(
    readonly scenario: string,
    readonly seed: number,
    map: Battlemap,
    specs: SimSpec[],
  ) {
    this.rng = seedRng(seed);
    this.map = structuredClone(map);
    this.state = replaySim([]);
    const entities: SimEntity[] = specs.map((s) => ({
      id: s.id,
      team: s.team,
      pos: { ...s.pos },
      size: s.size,
      hp: s.startsDying ? 0 : s.hp,
      maxHp: s.hp,
      ac: s.ac,
      speed: s.speed,
      abilities: s.abilities,
      attackBonus: s.attackBonus,
      damage: s.damage,
      damageType: s.damageType,
      ...(s.range ? { range: s.range } : {}),
      saveProficiencies: s.saveProficiencies ?? [],
      ...(s.caster ? { caster: s.caster } : {}),
      slotsUsed: {},
      conditions: s.startsDying ? [{ id: 'unconscious' as const }] : [],
      status: s.startsDying ? 'dying' : 'up',
      death: { successes: 0, failures: 0 },
      concentration: null,
    }));
    const doors = Object.fromEntries(
      this.map.edges
        .filter((e) => e.kind === 'door')
        .map((e) => [edgeKey(e.a, e.b), String(e.state)]),
    );
    const started = startCombat(
      this.combat,
      entities.map((e) => ({
        id: e.id,
        speed: e.speed,
        initiativeModifier: mod(e, 'dex'),
      })),
    );
    if (!('ok' in started)) throw new Error(started.error);
    const ev = started.events[0] as CombatEvent & { type: 'CombatStarted' };
    this.emit({
      type: 'CombatStarted',
      mapId: this.map.mapId,
      combatants: ev.combatants.map(({ id, speed }) => ({ id, speed })),
      entities,
      doors,
    });
    this.combat = applyCombat(this.combat, ev);
    const init = rollInitiative(this.combat, this.rng);
    if (!('ok' in init)) throw new Error(init.error);
    for (const e of init.events) {
      this.combat = applyCombat(this.combat, e);
      this.emit(e);
    }
    for (let i = 0; i < entities.length; i++)
      this.rng = nextDie(this.rng, 20)[1];
  }

  emit(event: SimEvent | CombatEvent | ConditionEvent): void {
    const e = structuredClone(event) as SimEvent;
    this.events.push(e);
    this.state = reduceSim(this.state, e);
  }
  /** Emit engine events, adding the EntityDown the spell engine does not produce. */
  emitAll(list: readonly { type: string }[]): void {
    list.forEach((raw, i) => {
      const e = raw as SimEvent;
      this.emit(e);
      if (e.type === 'ReactionSpent') this.reaction[String(e.entityId)] = false;
      if (e.type === 'EntityDown') this.afterDown(String(e.entityId));
      if (
        e.type === 'HpChanged' &&
        e.to === 0 &&
        Number(e.from) > 0 &&
        list[i + 1]?.type !== 'EntityDown'
      ) {
        const victim = this.get(String(e.entityId));
        this.emit({
          type: 'EntityDown',
          entityId: victim.id,
          outcome: victim.team === 'pc' ? 'unconscious' : 'dead',
        });
        this.afterDown(victim.id);
      }
    });
  }
  private afterDown(id: string) {
    const e = this.get(id);
    if (e.team === 'pc' && !e.conditions.some((c) => c.id === 'unconscious'))
      this.emit({
        type: 'ConditionApplied',
        entityId: id,
        condition: { id: 'unconscious' },
      });
    if (e.concentration) this.dropConcentration(e, e.concentration, true);
  }
  private dropConcentration(e: SimEntity, spellId: string, emitDrop: boolean) {
    if (emitDrop)
      this.emit({ type: 'ConcentrationDropped', entityId: e.id, spellId });
    for (const o of this.state.entities)
      for (const c of o.conditions)
        if (c.source === `${spellId}@${e.id}`)
          this.emit({ type: 'ConditionRemoved', entityId: o.id, id: c.id });
  }
  get(id: string): SimEntity {
    const e = this.state.entities.find((x) => x.id === id);
    if (!e) throw new Error(`unknown entity ${id}`);
    return e;
  }
  standing = (e: SimEntity) => e.hp > 0 && e.status !== 'dead';
  opponents(e: SimEntity) {
    return this.state.entities.filter(
      (o) => o.team !== e.team && this.standing(o),
    );
  }
  private d(a: SimEntity, b: SimEntity) {
    return distance(a, b, this.map.diagonalRule);
  }
  private draw(n: number) {
    for (let i = 0; i < n; i++) this.rng = nextDie(this.rng, 20)[1];
  }
  private diceIn(list: readonly { type: string }[]) {
    return list.reduce(
      (n, e) =>
        n +
        ((e as unknown as { breakdown?: { dice: unknown[] } }).breakdown?.dice
          .length ?? 0),
      0,
    );
  }
  private mapNow(): Battlemap {
    const edges = this.map.edges.map((e) =>
      e.kind === 'door' && this.state.doors[edgeKey(e.a, e.b)] === 'open'
        ? { ...e, state: 'open' as const }
        : e,
    );
    return { ...this.map, edges };
  }

  // ---- turn structure ---------------------------------------------------
  /** Run turns in initiative order until the fight resolves or maxRounds; always ends in CombatEnded. */
  run(
    turn: (sim: Sim, e: SimEntity) => void,
    opts: { maxRounds?: number } = {},
  ): SimLog {
    const maxRounds = opts.maxRounds ?? 10;
    const order = this.combat.initiative.map((i) => i.entityId);
    let reason: string | null = null;
    outer: for (;;)
      for (let i = 0; i < order.length; i++) {
        reason = this.endReason();
        if (reason) break outer;
        if (i === 0 && this.combat.round >= maxRounds) {
          reason = 'round-cap';
          break outer;
        }
        this.takeTurn(order[i]!, turn);
      }
    this.emit({ type: 'CombatEnded', reason });
    return {
      scenario: this.scenario,
      seed: this.seed,
      events: this.events,
      finalState: this.state,
    };
  }
  private endReason(): string | null {
    const pcs = this.state.entities.filter((e) => e.team === 'pc');
    const foes = this.state.entities.filter((e) => e.team === 'foe');
    if (foes.every((e) => !this.standing(e))) {
      return pcs.some((e) => e.status === 'dying')
        ? null
        : pcs.every((e) => e.status === 'dead')
          ? 'party-dead'
          : 'foes-defeated';
    }
    if (pcs.every((e) => !this.standing(e) && e.status !== 'dying'))
      return pcs.every((e) => e.status === 'dead')
        ? 'party-dead'
        : 'party-down';
    return null;
  }
  private takeTurn(id: string, turn: (sim: Sim, e: SimEntity) => void) {
    const e = this.get(id);
    const skipped = e.status === 'dead' || (e.team === 'foe' && e.hp <= 0);
    const started = startTurnWithConditions(
      this.combat,
      { [id]: e.conditions },
      id,
    );
    if (!('ok' in started)) throw new Error(started.error);
    // Dead creatures still advance the engine's turn order, but leave no events.
    for (const ev of started.events) {
      if (ev.type !== 'ActionsSkipped')
        this.combat = applyCombat(this.combat, ev as CombatEvent);
      if (!skipped) this.emit(ev);
    }
    if (!skipped) {
      this.reaction[id] = !started.events.some(
        (s) => s.type === 'ReactionSpent',
      );
      this.movementLeft[id] = this.combat.resources[id]!.movementRemaining;
      if (e.status === 'dying') this.deathSaveTurn(id);
      else if (
        e.status === 'up' &&
        !started.events.some((s) => s.type === 'ActionsSkipped')
      )
        turn(this, this.get(id));
      if (this.get(id).conditions.some((c) => c.durationRounds !== undefined))
        this.emit({ type: 'ConditionsTicked', entityId: id });
    }
    const ended = { type: 'TurnEnded', entityId: id } as const;
    this.combat = applyCombat(this.combat, ended);
    if (!skipped) this.emit(ended);
  }

  // ---- actions ------------------------------------------------------------
  deathSaveTurn(id: string) {
    const e = this.get(id);
    const saves: DeathSaves = {
      ...freshDeathSaves(),
      successes: e.death.successes,
      failures: e.death.failures,
    };
    const [res, next] = deathSave(saves, this.rng);
    this.rng = next;
    if ('error' in res) throw new Error(res.error);
    const s = res.state;
    this.emit({
      type: 'DeathSave',
      entityId: id,
      die: res.die,
      successes: s.successes,
      failures: s.failures,
      stable: s.stable,
      dead: s.dead,
      revived: res.die === 20,
    });
    if (res.die === 20) {
      this.emit({ type: 'HpChanged', entityId: id, from: 0, to: 1, amount: 1 });
      this.emit({ type: 'ConditionRemoved', entityId: id, id: 'unconscious' });
    }
  }

  private conditionsMap(): ConditionState {
    return Object.fromEntries(
      this.state.entities.map((e) => [e.id, e.conditions]),
    );
  }

  /**
   * Move along `path`, spending movement; stops (no event) if it would exceed the
   * remaining budget. Opportunity attacks are always taken by the provoked hostile.
   */
  move(
    id: string,
    path: readonly GridPos[],
    mode: 'normal' | 'disengage' = 'normal',
  ) {
    const mover = this.get(id);
    const living = this.state.entities.filter(
      (e) => e.status !== 'dead' && (e.hp > 0 || e.status !== 'up'),
    );
    const build = (): MovementCommandState => ({
      map: this.mapNow(),
      entities: living.map((e) => ({
        id: e.id,
        team: e.team,
        pos: e.pos,
        size: e.size,
        hp: e.hp,
        kind: e.team === 'pc' ? ('pc' as const) : ('monster' as const),
        ac: e.ac,
        reaction: this.reaction[e.id] ?? true,
        opportunityAttack: {
          seed: this.rng,
          attackId: 'opportunity',
          attackBonus: e.attackBonus,
          damage: e.damage,
          damageType: e.damageType,
          targetAc: mover.ac,
        },
      })),
      hp: Object.fromEntries(living.map((e) => [e.id, e.hp])),
      conditions: this.conditionsMap(),
      resources: Object.fromEntries(
        living.map((e) => [
          e.id,
          {
            movementRemaining: this.movementLeft[e.id] ?? 0,
            reaction: this.reaction[e.id] ?? true,
          },
        ]),
      ),
      reactions: Object.fromEntries(
        living.map((e) => [e.id, this.reaction[e.id] ?? true]),
      ),
    });
    let result = moveAlong(build(), id, path, mode);
    if ('error' in result) return result;
    this.emitAll(result.events);
    this.movementLeft[id] = (this.movementLeft[id] ?? 0) - spent(result.events);
    while (result.pending.length) {
      const pending = result.pending[0]!;
      const base = result.state;
      // thread the shared RNG into the reacting hostile's attack
      const hostile = base.entities.find((x) => x.id === pending.hostileId)!;
      const seeded: MovementCommandState = {
        ...base,
        entities: base.entities.map((x) =>
          x.id === hostile.id && x.opportunityAttack
            ? {
                ...x,
                opportunityAttack: { ...x.opportunityAttack, seed: this.rng },
              }
            : x,
        ),
      };
      const reaction = resolveReaction(seeded, pending.reactionId, 'take');
      if ('error' in reaction) return reaction;
      this.draw(this.diceIn(reaction.events));
      this.emitAll(reaction.events);
      this.movementLeft[id] =
        (this.movementLeft[id] ?? 0) - spent(reaction.events);
      result = reaction;
    }
    return { ok: true as const };
  }

  /** Follow `path` as far as the remaining movement allows (policy paths can be longer than a turn). */
  moveWithinBudget(id: string, path: readonly GridPos[]) {
    const mover = this.get(id);
    const st = {
      map: this.mapNow(),
      entities: [],
      conditions: this.conditionsMap(),
    };
    let left = this.movementLeft[id] ?? 0;
    if (
      mover.conditions.some((c) => c.id === 'grappled' || c.id === 'restrained')
    )
      left = 0;
    const cut: GridPos[] = [path[0]!];
    for (const cell of path.slice(1)) {
      const c = movementCost(
        st,
        { id: mover.id, pos: mover.pos, size: mover.size },
        cell,
      );
      if (c > left) break;
      left -= c;
      cut.push(cell);
    }
    if (cut.length < 2)
      return {
        error: 'no movement',
        hint: '',
        reason: 'insufficient_movement',
      };
    return this.move(id, cut);
  }

  melee(attackerId: string, targetId: string) {
    return this.strike(attackerId, targetId, false);
  }
  shoot(attackerId: string, targetId: string) {
    const r = this.strike(attackerId, targetId, true);
    if ('error' in r)
      this.emit({
        type: 'AttackRefused',
        attackerId,
        targetId,
        reason: r.error,
      });
    return r;
  }
  private strike(attackerId: string, targetId: string, ranged: boolean) {
    const a = this.get(attackerId);
    const t = this.get(targetId);
    const dist = this.d(a, t);
    const dying = t.hp === 0 && t.status === 'dying';
    const input = {
      attackerId,
      targetId,
      attackId: ranged ? 'ranged' : 'melee',
      seed: this.rng,
      attackBonus: a.attackBonus,
      damage: a.damage,
      damageType: a.damageType,
      targetAc: t.ac,
      mode: this.attackMode(a, t, dist, ranged),
      map: {
        map: this.mapNow(),
        attacker: a,
        target: t,
        ...(ranged && a.range ? { range: a.range } : {}),
      },
      // a dying target is attacked as if it had HP so the hit/damage rolls happen; the HP change is replaced below
      target: {
        hp: dying ? 1 : t.hp,
        kind: t.team === 'pc' ? ('pc' as const) : ('monster' as const),
      },
    };
    const result = attack(input);
    if ('error' in result) return result;
    this.rng = result.rng;
    if (!dying) {
      this.emitAll(result.events);
      this.concentrationCheck(t, result.events);
      return { ok: true as const, hit: result.hit };
    }
    // SRD: damage at 0 HP is a death-save failure; a hit from within 5 ft is a crit (2 failures).
    this.emitAll(result.events.filter((e) => e.type === 'RollEvent'));
    if (result.hit) {
      const failures = t.death.failures + (dist <= 5 || result.crit ? 2 : 1);
      const dead = failures >= 3;
      this.emit({
        type: 'DeathSave',
        entityId: t.id,
        die: null,
        source: 'damage-at-0hp',
        successes: t.death.successes,
        failures,
        stable: false,
        dead,
        revived: false,
      });
    }
    return { ok: true as const, hit: result.hit };
  }
  /** Condition-derived mode, plus the SRD rule that a ranged attack with a hostile within 5 ft has disadvantage. */
  private attackMode(
    a: SimEntity,
    t: SimEntity,
    dist: number,
    ranged: boolean,
  ) {
    const mode = attackRollMode(a.conditions, t.conditions, dist);
    if (ranged && this.opponents(a).some((o) => this.d(a, o) <= 5))
      return mode === 'advantage' ? 'normal' : 'disadvantage';
    return mode;
  }
  private concentrationCheck(t: SimEntity, events: readonly AttackEvent[]) {
    const hp = events.find((e) => e.type === 'HpChanged');
    const live = this.get(t.id);
    if (!hp || hp.type !== 'HpChanged' || !live.concentration || live.hp <= 0)
      return;
    const spellState: SpellState = {
      concentration: { [live.id]: live.concentration },
      hp: {},
      slots: {},
    };
    const bonus =
      mod(live, 'con') +
      (live.saveProficiencies.includes('con') ? profBonus(live) : 0);
    const spellId = live.concentration;
    const res = concentrationSave(
      live.id,
      hp.damage,
      bonus,
      this.rng,
      spellState,
    );
    if ('error' in res) return;
    this.rng = res.rng;
    this.emit({
      type: 'ConcentrationChecked',
      entityId: live.id,
      damage: hp.damage,
      success: res.success,
    });
    for (const e of res.events) {
      this.emit(e);
      if (e.type === 'ConcentrationDropped')
        this.dropConcentration(live, spellId, false);
    }
  }

  cast(
    casterId: string,
    spellId: string,
    slotLevel: number,
    target: { id: string } | { anchor: GridPos; direction?: GridPos },
    onFailedSave?: ConditionId[],
  ) {
    const c = this.get(casterId);
    if (!c.caster) throw new Error(`${casterId} is not a caster`);
    const targets = this.state.entities.map((e) => ({
      id: e.id,
      hp: e.hp,
      maxHp: e.maxHp,
      ac: e.ac,
      abilities: e.abilities,
      proficiencies: { saves: e.saveProficiencies },
    }));
    const slots = Object.fromEntries(
      Object.entries(c.caster.slots).map(([lvl, max]) => [
        lvl,
        { max, used: c.slotsUsed[lvl] ?? 0 },
      ]),
    );
    const single =
      'id' in target ? targets.find((t) => t.id === target.id)! : undefined;
    const result = castSpell({
      caster: {
        id: c.id,
        name: c.id,
        speciesId: 'species:human',
        classId: c.caster.classId,
        backgroundId: 'background:acolyte',
        level: c.caster.level,
        abilities: c.abilities,
        proficiencies: { skills: [], saves: c.saveProficiencies, tools: [] },
        equipment: [],
        spellsKnown: [spellId],
        spellsPrepared: [spellId],
        slots,
        hp: { current: c.hp, max: c.maxHp, temp: 0 },
        conditions: [],
      },
      target: single ?? {
        kind: 'anchor',
        pos: (target as { anchor: GridPos }).anchor,
      },
      spellId,
      slotLevel,
      seed: this.rng,
      catalog,
      state: {
        concentration: { [c.id]: c.concentration },
        hp: Object.fromEntries(this.state.entities.map((e) => [e.id, e.hp])),
        slots: { [c.id]: slots },
      },
      map: {
        map: this.mapNow(),
        caster: c,
        entities: this.state.entities
          .filter((e) => e.status !== 'dead')
          .map((e) => ({ id: e.id, pos: e.pos, size: e.size, team: e.team })),
        targets,
        ...('anchor' in target
          ? {
              anchor: target.anchor,
              direction: target.direction ?? { x: 0, y: 1 },
            }
          : {}),
      },
    });
    if ('error' in result) return result;
    this.rng = result.rng;
    this.emitAll(result.events);
    if (single && result.saveSucceeded === false && onFailedSave)
      for (const id of onFailedSave)
        this.emit({
          type: 'ConditionApplied',
          entityId: single.id,
          condition: { id, source: `${spellId}@${c.id}` },
        });
    return { ok: true as const, result };
  }

  /** Full route to `goal` ignoring this turn's budget (pair with moveWithinBudget). */
  routeTo(id: string, goal: GridPos): GridPos[] | null {
    const r = findPath(
      {
        map: this.mapNow(),
        entities: this.state.entities
          .filter((e) => e.status !== 'dead' && e.hp > 0)
          .map((e) => ({ id: e.id, team: e.team, pos: e.pos, size: e.size })),
        resources: { [id]: { movementLeft: Infinity } },
        conditions: this.conditionsMap(),
      },
      id,
      goal,
    );
    return 'path' in r ? r.path : null;
  }
  movementOf = (id: string) => this.movementLeft[id] ?? 0;
  doorIsClosed(a: GridPos, b: GridPos) {
    const s = this.state.doors[edgeKey(a, b)];
    return s !== undefined && s !== 'open';
  }
  applyCondition(entityId: string, condition: ActiveCondition) {
    this.emit({ type: 'ConditionApplied', entityId, condition });
  }
  /** One-step move attempt; a refusal (e.g. grappled: speed 0) is logged, not thrown. */
  tryMove(id: string, to: GridPos) {
    const from = this.get(id).pos;
    const r = this.move(id, [from, to]);
    if ('error' in r)
      this.emit({ type: 'MoveRefused', entityId: id, to, reason: r.reason });
    return r;
  }

  openDoor(id: string, a: GridPos, b: GridPos) {
    const e = this.get(id);
    const near = (p: GridPos) =>
      inReach(e, { pos: p, size: 1 }, 5, this.map.diagonalRule);
    if (!near(a) && !near(b)) return { error: 'too far from the door' };
    this.emit({ type: 'DoorOpened', entityId: id, a, b });
    return { ok: true as const };
  }

  /** Contested Athletics-style check; winner applies `condition` to the target. */
  contest(attackerId: string, targetId: string, condition: ConditionId) {
    const a = this.get(attackerId);
    const t = this.get(targetId);
    const best = (e: SimEntity) => Math.max(mod(e, 'str'), mod(e, 'dex'));
    const [r, next] = contestedCheck(
      {
        ability: 'str',
        modifier: mod(a, 'str'),
        skill: 'Athletics',
        conditions: a.conditions,
      },
      {
        ability: best(t) === mod(t, 'str') ? 'str' : 'dex',
        modifier: best(t),
        skill: best(t) === mod(t, 'str') ? 'Athletics' : 'Acrobatics',
        conditions: t.conditions,
      },
      this.rng,
      `${condition} contest`,
    );
    this.rng = next;
    if ('error' in r) return r;
    this.emit({
      type: 'ContestResolved',
      attackerId,
      targetId,
      condition,
      attackerTotal: r.a.total,
      targetTotal: r.b.total,
      winner: r.winner,
    });
    if (r.winner === 'a')
      this.emit({
        type: 'ConditionApplied',
        entityId: targetId,
        condition: { id: condition, source: attackerId },
      });
    return { ok: true as const, winner: r.winner };
  }
  /** Contested escape from `grappled`; success removes the condition. */
  escape(id: string) {
    const e = this.get(id);
    const g = e.conditions.find((c) => c.id === 'grappled');
    if (!g?.source) return { error: 'not grappled' };
    const holder = this.get(g.source);
    const [r, next] = contestedCheck(
      {
        ability: 'str',
        modifier: Math.max(mod(e, 'str'), mod(e, 'dex')),
        skill: 'Escape',
        conditions: e.conditions,
      },
      {
        ability: 'str',
        modifier: mod(holder, 'str'),
        skill: 'Athletics',
        conditions: holder.conditions,
      },
      this.rng,
      'escape grapple',
    );
    this.rng = next;
    if ('error' in r) return r;
    this.emit({
      type: 'ContestResolved',
      attackerId: id,
      targetId: holder.id,
      condition: 'escape-grapple',
      attackerTotal: r.a.total,
      targetTotal: r.b.total,
      winner: r.winner,
    });
    if (r.winner === 'a')
      this.emit({ type: 'ConditionRemoved', entityId: id, id: 'grappled' });
    return { ok: true as const, winner: r.winner };
  }
  /** Standing up costs half the creature's speed. */
  standUp(id: string) {
    const e = this.get(id);
    const cost = Math.floor(e.speed / 2);
    if (!e.conditions.some((c) => c.id === 'prone'))
      return { error: 'not prone' };
    if ((this.movementLeft[id] ?? 0) < cost)
      return { error: 'not enough movement' };
    this.emit({ type: 'ConditionRemoved', entityId: id, id: 'prone' });
    this.emit({ type: 'MovementSpent', entityId: id, feet: cost });
    this.movementLeft[id] = (this.movementLeft[id] ?? 0) - cost;
    return { ok: true as const };
  }

  /** Default turn: monsterPolicy drives approach / attack / flee for any entity. */
  policyTurn(e: SimEntity, opts: { fleeBelow?: number } = {}) {
    const fleeing =
      opts.fleeBelow !== undefined && e.hp <= e.maxHp * opts.fleeBelow;
    const decide = () => {
      const choice = monsterPolicy({
        map: this.mapNow(),
        entities: this.state.entities.map((x) => ({
          ...x,
          conditions: x.conditions.map((c) => c.id),
          hp: this.standing(x) ? x.hp : 0,
        })),
        monsterId: e.id,
        fleeing,
      });
      this.emit({ type: 'PolicyDecision', entityId: e.id, kind: choice.kind });
      return choice;
    };
    let d = decide();
    if (d.kind === 'flee') {
      // flee in 5 ft steps until movement runs out (provokes unless nobody is in reach)
      for (let guard = 0; guard < 12 && d.kind === 'flee'; guard++) {
        if (this.get(e.id).hp <= 0) return;
        const r = this.moveWithinBudget(e.id, d.path);
        if ('error' in r || this.get(e.id).hp <= 0) break;
        d = decide();
      }
      return;
    }
    if (d.kind === 'approach') {
      this.moveWithinBudget(e.id, d.path);
      if (this.get(e.id).hp <= 0) return;
      d = decide();
    }
    if (d.kind === 'attack') this.melee(e.id, d.targetId);
  }
}

function spent(events: readonly { type: string }[]) {
  return events.reduce(
    (n, e) =>
      n +
      (e.type === 'MovementSpent' ? Number((e as { feet?: number }).feet) : 0),
    0,
  );
}

export { startTurnWithConditions };
export type { CombatState };
