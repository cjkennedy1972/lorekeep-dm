import { rleEncode, type Battlemap, type GridPos } from '@game/schema';
import type { Catalog } from '../catalog/types.js';
import { buildEncounter, type BuiltEncounter } from '../encounter/budget.js';
import { distance } from '../map/geometry.js';
import { Sim, type SimEntity, type SimSpec } from '../scripted/sim.js';
import type { DayState, Pc } from './pc.js';

/** Open 30x30 grass arena: no cover, no terrain, so results do not depend on a hand-built map. */
export const ARENA: Battlemap = {
  mapId: 'solo-cal-arena',
  w: 30,
  h: 30,
  palette: [
    {
      terrainId: 'grass',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: rleEncode(new Array<number>(900).fill(0)),
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
/** Opening distance between the PC and the nearest foe row: 40 ft. */
const PC_POS: GridPos = { x: 15, y: 24 };
const FOE_ROW = 16;
export const MAX_ROUNDS = 20;

export type FoeInfo = {
  strikes: number;
  /** No melee attack at all: shoots from where it stands or after closing to range. */
  rangedOnly: boolean;
};

type CatalogMonster = Extract<
  NonNullable<ReturnType<Catalog['get']>>,
  { kind: 'monster' }
>;

/** Turn a catalog monster into a sim combatant: its primary attack repeated per Multiattack. */
export function foeFromMonster(
  catalog: Catalog,
  monsterId: string,
  id: string,
  pos: GridPos,
): { spec: SimSpec; info: FoeInfo } {
  const m = catalog.get('monster', monsterId) as CatalogMonster | undefined;
  if (!m?.abilities) throw new Error(`incomplete monster ${monsterId}`);
  const attacks = m.attacks ?? [];
  const byId = (aid: string) =>
    attacks.find(
      (a) => (a.id ?? a.name.toLowerCase().replace(/\s+/g, '-')) === aid,
    );
  const steps = m.multiattack ?? [];
  const stepAttacks = steps.flatMap((s) => {
    const a = byId(s.attackId);
    return a ? [{ a, count: s.count }] : [];
  });
  const strikes = stepAttacks.length
    ? stepAttacks.reduce((n, s) => n + s.count, 0)
    : attacks.length
      ? 1
      : 0;
  const primary =
    [...stepAttacks]
      .sort((x, y) => y.count - x.count)
      .map((s) => s.a)
      .find((a) => a.reachFt) ??
    stepAttacks[0]?.a ??
    attacks.find((a) => a.reachFt) ??
    attacks[0];
  const flat = (dice: string) => (/d/.test(dice) ? dice : `${dice}d1`);
  const rangedOnly = !!primary && !primary.reachFt;
  const spec: SimSpec = {
    id,
    team: 'foe',
    pos,
    size: m.footprint ?? 1,
    hp: m.hp,
    ac: m.ac,
    speed: m.speed,
    abilities: m.abilities as SimSpec['abilities'],
    attackBonus: primary?.toHit ?? 0,
    damage: flat(primary?.damage[0]?.dice ?? '1'),
    damageType: primary?.damage[0]?.type ?? 'bludgeoning',
    ...(rangedOnly && primary?.range
      ? {
          range: {
            normalFt: primary.range.normalFt,
            longFt: primary.range.longFt ?? primary.range.normalFt,
          },
        }
      : {}),
  };
  return { spec, info: { strikes, rangedOnly } };
}

const dist = (sim: Sim, a: SimEntity, b: SimEntity) =>
  distance(a, b, sim.map.diagonalRule);

/** Foes fight to the death: close, then repeat the primary attack per Multiattack. No fleeing. */
function foeTurn(sim: Sim, e: SimEntity, info: FoeInfo) {
  if (!info.strikes) return;
  // A downed PC is still attacked (SRD: damage at 0 HP is a death-save failure).
  const targets = () => {
    const up = sim.opponents(sim.get(e.id));
    return up.length
      ? up
      : sim.state.entities.filter(
          (o) => o.team === 'pc' && o.status === 'dying',
        );
  };
  const nearest = () =>
    [...targets()].sort(
      (x, y) => dist(sim, e, x) - dist(sim, e, y) || x.id.localeCompare(y.id),
    )[0];
  let t = nearest();
  if (!t) return;
  const self = sim.get(e.id);
  if (info.rangedOnly) {
    const range = self.range?.normalFt ?? 5;
    if (dist(sim, self, t) > range) {
      sim.approach(self);
      t = nearest();
      if (!t || dist(sim, sim.get(e.id), t) > range) return;
    }
    for (let i = 0; i < info.strikes; i++) {
      t = nearest();
      if (!t) return;
      sim.shoot(e.id, t.id);
    }
    return;
  }
  if (dist(sim, self, t) > 5) {
    sim.approach(self);
    if (sim.get(e.id).hp <= 0) return;
    t = nearest();
    if (!t || dist(sim, sim.get(e.id), t) > 5) return;
  }
  for (let i = 0; i < info.strikes; i++) {
    t = nearest();
    if (!t || dist(sim, sim.get(e.id), t) > 5) return;
    sim.melee(e.id, t.id);
  }
}

export type FightResult = {
  win: boolean;
  dead: boolean;
  /** PC dropped to 0 HP at some point (needs death saves / rescue in play). */
  ko: boolean;
  hpEnd: number;
  hpStart: number;
  rounds: number;
  reason: string;
};

export function foePositions(sizes: number[]): GridPos[] {
  const total = sizes.reduce((n, s) => n + s + 1, 0) - 1;
  let x = Math.max(0, Math.min(29 - total, PC_POS.x - Math.floor(total / 2)));
  return sizes.map((s) => {
    const pos = { x, y: FOE_ROW };
    x += s + 1;
    return pos;
  });
}

export function runFight(
  catalog: Catalog,
  pc: Pc,
  day: DayState,
  encounter: BuiltEncounter,
  seed: number,
): { result: FightResult; next: DayState } {
  const working: DayState = { ...day, slotsUsed: { ...day.slotsUsed } };
  const foes = encounter.monsters.map((m, i) => ({ m, i }));
  const sizes = foes.map(({ m }) => {
    const mon = catalog.get('monster', m.id) as CatalogMonster | undefined;
    return mon?.footprint ?? 1;
  });
  const positions = foePositions(sizes);
  const infos = new Map<string, FoeInfo>();
  const specs = foes.map(({ m, i }) => {
    const f = foeFromMonster(catalog, m.id, `foe-${i}`, positions[i]!);
    infos.set(f.spec.id, f.info);
    return f.spec;
  });
  const pcSpec = pc.specFor(working);
  const sim = new Sim('solo-cal', seed, ARENA, [pcSpec, ...specs]);
  const log = sim.run(
    (s, e) =>
      e.team === 'pc'
        ? pc.turn(s, e, working)
        : foeTurn(s, e, infos.get(e.id)!),
    { maxRounds: MAX_ROUNDS },
  );
  const final = sim.get(pcSpec.id);
  const reason = String(
    (log.events[log.events.length - 1] as { reason?: string }).reason,
  );
  const ko = log.events.some(
    (ev) => ev.type === 'HpChanged' && ev.entityId === pcSpec.id && ev.to === 0,
  );
  const next = pc.after(sim, working);
  return {
    result: {
      win: reason === 'foes-defeated' && final.status !== 'dead',
      dead: final.status === 'dead',
      ko,
      hpEnd: next.hp,
      hpStart: day.hp,
      rounds: sim.state.round,
      reason,
    },
    next,
  };
}

/** Deterministic 32-bit mix so that fight seeds do not collide across (class, level, index). */
export function mixSeed(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export type EncounterShape = { multiplier: number; maxEnemies?: number };

export function encounterFor(
  catalog: Catalog,
  level: number,
  shape: EncounterShape,
  seed: number,
  difficulty: 'low' | 'moderate' | 'high' = 'moderate',
): BuiltEncounter {
  return buildEncounter(catalog, {
    level,
    seed,
    difficulty,
    soloBudget: {
      multiplier: shape.multiplier,
      ...(shape.maxEnemies !== undefined
        ? { maxEnemies: shape.maxEnemies }
        : {}),
    },
  });
}

export type SequenceResult = {
  fights: FightResult[];
  survived: boolean;
  wonAll: boolean;
};
/** Three encounters back to back (optionally a short rest between), stopping when the PC fails. */
export function runSequence(
  catalog: Catalog,
  pc: Pc,
  level: number,
  shape: EncounterShape,
  seed: number,
  rest: 'none' | 'short',
  count = 3,
): SequenceResult {
  let day = pc.fresh();
  const fights: FightResult[] = [];
  for (let i = 0; i < count; i++) {
    const enc = encounterFor(catalog, level, shape, mixSeed(seed, i, 1));
    const { result, next } = runFight(
      catalog,
      pc,
      day,
      enc,
      mixSeed(seed, i, 2),
    );
    fights.push(result);
    if (!result.win) break;
    day = rest === 'short' && i < count - 1 ? pc.rest(next, 'short') : next;
  }
  return {
    fights,
    survived: fights.every((f) => !f.dead),
    wonAll: fights.length === count && fights.every((f) => f.win),
  };
}
