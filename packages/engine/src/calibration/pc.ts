import type { Ability } from '@game/schema';
import { quickBuild } from '../character/builder.js';
import type { CharacterCatalog } from '../character/types.js';
import { scaledDamage } from '../combat/spells.js';
import { abilityModifier } from '../dice.js';
import { distance } from '../map/geometry.js';
import type { Sim, SimEntity, SimSpec } from '../scripted/sim.js';

/**
 * Solo-calibration PC model. Quick build supplies abilities, HP, slots and spells; the
 * quick-build sheet carries no gear, so each class gets the armor and weapons of its SRD 5.2.1
 * starting-equipment option A (Classes > <class> > Core Traits; Equipment > Armor / Weapons).
 * Class features are modelled only where they change a solo fight in plain numbers.
 * Subclass features are NOT modelled (see docs/plan/verification/solo-calibration.md).
 */
export type PolicyVersion = 'v0' | 'v1' | 'v2';
export const POLICY_VERSIONS: readonly PolicyVersion[] = ['v0', 'v1', 'v2'];

const prof = (level: number) => 2 + Math.floor((level - 1) / 4);
type Abil = Record<Ability, number>;
const m = (a: Abil, k: Ability) => abilityModifier(a[k]);

type Kit = {
  ac: (a: Abil) => number;
  melee: { dice: string; finesse: boolean };
  ranged?: { dice: string; normalFt: number; longFt: number; ability: Ability };
  extraAttackLevel: number;
};
const KITS: Record<string, Kit> = {
  barbarian: {
    ac: (a) => 10 + m(a, 'dex') + m(a, 'con'),
    melee: { dice: '1d12', finesse: false },
    extraAttackLevel: 5,
  },
  bard: {
    ac: (a) => 11 + m(a, 'dex'),
    melee: { dice: '1d4', finesse: true },
    extraAttackLevel: 99,
  },
  cleric: {
    ac: (a) => 13 + Math.min(2, m(a, 'dex')) + 2,
    melee: { dice: '1d6', finesse: false },
    extraAttackLevel: 99,
  },
  druid: {
    ac: (a) => 11 + m(a, 'dex') + 2,
    melee: { dice: '1d6', finesse: false },
    extraAttackLevel: 99,
  },
  fighter: {
    ac: () => 16,
    melee: { dice: '2d6', finesse: false },
    ranged: { dice: '1d6', normalFt: 30, longFt: 120, ability: 'str' },
    extraAttackLevel: 5,
  },
  monk: {
    ac: (a) => 10 + m(a, 'dex') + m(a, 'wis'),
    melee: { dice: '1d6', finesse: true },
    extraAttackLevel: 5,
  },
  paladin: {
    ac: () => 18,
    melee: { dice: '1d8', finesse: false },
    extraAttackLevel: 5,
  },
  ranger: {
    ac: (a) => 12 + m(a, 'dex'),
    melee: { dice: '1d6', finesse: true },
    ranged: { dice: '1d8', normalFt: 150, longFt: 600, ability: 'dex' },
    extraAttackLevel: 5,
  },
  rogue: {
    ac: (a) => 11 + m(a, 'dex'),
    melee: { dice: '1d6', finesse: true },
    ranged: { dice: '1d6', normalFt: 80, longFt: 320, ability: 'dex' },
    extraAttackLevel: 99,
  },
  sorcerer: {
    ac: (a) => 10 + m(a, 'dex'),
    melee: { dice: '1d6', finesse: false },
    extraAttackLevel: 99,
  },
  warlock: {
    ac: (a) => 11 + m(a, 'dex'),
    melee: { dice: '1d4', finesse: true },
    extraAttackLevel: 99,
  },
  wizard: {
    ac: (a) => 10 + m(a, 'dex'),
    melee: { dice: '1d4', finesse: true },
    extraAttackLevel: 99,
  },
};
export const CLASS_SLUGS = Object.keys(KITS);
const slugOf = (classId: string) => classId.replace('class:', '');

/** Features and resources that persist across encounters until a rest. */
export type DayState = {
  hp: number;
  slotsUsed: Record<string, number>;
  rage: number;
  secondWind: number;
  actionSurge: number;
  layOnHands: number;
};

export type Pc = {
  slug: string;
  level: number;
  policy: PolicyVersion;
  spec: SimSpec;
  maxHp: number;
  hitDie: number;
  conMod: number;
  /** Spells castable by this PC under its policy. */
  cantrips: string[];
  spells: string[];
  fresh(): DayState;
  rest(day: DayState, kind: 'short' | 'long'): DayState;
  /** Build the SimSpec for a fight starting from `day`. */
  specFor(day: DayState): SimSpec;
  turn(sim: Sim, e: SimEntity, day: DayState): void;
  /** Resource state after a fight (HP and slots read back from the sim). */
  after(sim: Sim, day: DayState): DayState;
};

const maxUses = (slug: string, level: number) => ({
  rage: slug === 'barbarian' ? (level < 3 ? 2 : 3) : 0,
  secondWind: slug === 'fighter' ? 2 : 0,
  actionSurge: slug === 'fighter' && level >= 2 ? 1 : 0,
  layOnHands: slug === 'paladin' ? 5 * level : 0,
});

const dmg = (dice: string, bonus: number) =>
  bonus === 0 ? dice : `${dice}${bonus > 0 ? '+' : ''}${bonus}`;
const avgDice = (expr: string) => {
  const t = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr);
  if (!t) return Number(expr) || 0;
  return Number(t[1]) * ((Number(t[2]) + 1) / 2) + Number(t[3] ?? 0);
};

type SpellEntry = Extract<
  ReturnType<CharacterCatalog['get']> & object,
  { kind: 'spell' }
>;

/** Rough expected damage of casting `spell` at `slot`, used only to rank options. */
function expectedDamage(spell: SpellEntry, slot: number, level: number) {
  let total = 0;
  for (const d of spell.damage ?? []) {
    const s = scaledDamage(d, spell.level, slot, level);
    total += s.count * avgDice(s.dice);
  }
  const kind = spell.resolution?.kind;
  return total * (kind === 'attack' ? 0.65 : kind === 'save' ? 0.75 : 1);
}

export function buildPc(
  catalog: CharacterCatalog,
  classId: string,
  level: number,
  policy: PolicyVersion,
): Pc {
  const slug = slugOf(classId);
  const kit = KITS[slug];
  if (!kit) throw new Error(`no calibration kit for ${classId}`);
  const { character } = quickBuild(catalog, classId, 1, level);
  const klass = catalog.get('class', classId)!;
  const a = character.abilities;
  const pb = prof(level);
  const maxHp = character.hp.max;
  const conMod = m(a, 'con');
  const slotsMax: Record<string, number> = {};
  for (const [k, v] of Object.entries(character.slots)) slotsMax[k] = v.max;
  const spellAbility = klass.spellcastingAbility;
  const maxSlot = Math.max(0, ...Object.keys(slotsMax).map(Number));

  const spellPool = (ids: string[]) =>
    ids.flatMap((id) => {
      const s = catalog.get('spell', id);
      return s && s.kind === 'spell' ? [s] : [];
    });
  let cantripIds = [...character.spellsKnown];
  let spellIds = [...character.spellsPrepared];
  if (policy === 'v2' && spellAbility) {
    // A player who picks damage and healing: the best catalog spells on the class list, same counts.
    const onList = catalog.entries.filter(
      (e): e is SpellEntry =>
        e.kind === 'spell' &&
        e.classes.includes(klass.name.toLowerCase()) &&
        !e.concentration &&
        (e.castingTime?.unit ?? 'action') === 'action' &&
        (e.resolution?.kind === 'attack' ||
          e.resolution?.kind === 'save' ||
          !!e.healing) &&
        (!!e.damage?.length || !!e.healing),
    );
    const score = (s: SpellEntry) =>
      s.healing
        ? avgDice(s.healing.dice) * 0.6
        : expectedDamage(
            s,
            Math.max(s.level, Math.min(maxSlot, s.level)),
            level,
          );
    const rank = (list: SpellEntry[], n: number) =>
      [...list]
        .sort((x, y) => score(y) - score(x) || x.id.localeCompare(y.id))
        .slice(0, n)
        .map((s) => s.id);
    cantripIds = rank(
      // a solo caster wants distance: cantrips reaching at least 60 ft
      onList.filter(
        (s) => s.level === 0 && s.range?.kind === 'feet' && s.range.feet >= 60,
      ),
      Math.max(1, character.spellsKnown.length),
    );
    spellIds = rank(
      onList.filter((s) => s.level > 0 && s.level <= maxSlot),
      Math.max(2, character.spellsPrepared.length),
    );
  }
  const useSpells = policy !== 'v0' && !!spellAbility;
  const cantrips = useSpells ? cantripIds : [];
  const spells = useSpells ? spellIds : [];

  // v2 only: a prepared arcanist casts Mage Armor (8 h, so one 1st-level slot per day).
  const mageArmor =
    policy === 'v2' && (slug === 'wizard' || slug === 'sorcerer');
  const strMod = m(a, 'str');
  const dexMod = m(a, 'dex');
  const meleeMod = kit.melee.finesse ? Math.max(strMod, dexMod) : strMod;
  const monkDie = slug === 'monk' ? (level >= 5 ? '1d8' : '1d6') : null;
  const meleeDice = monkDie ?? kit.melee.dice;
  const attacksPerAction =
    level >= kit.extraAttackLevel && policy !== 'v0' ? 2 : 1;
  const meleeBonus = (extra = 0, riders = 0) => ({
    attackBonus: meleeMod + pb + extra,
    damage: dmg(meleeDice, meleeMod + riders),
  });
  const rangedMod = kit.ranged ? m(a, kit.ranged.ability) : 0;

  const spec: SimSpec = {
    id: `pc-${slug}`,
    team: 'pc',
    pos: { x: 12, y: 18 },
    size: 1,
    hp: maxHp,
    ac: mageArmor ? 13 + dexMod : kit.ac(a),
    speed: 30,
    abilities: a,
    attackBonus: meleeMod + pb,
    damage: dmg(meleeDice, meleeMod),
    damageType: 'slashing',
    ...(kit.ranged
      ? {
          range: {
            normalFt: kit.ranged.normalFt,
            longFt: kit.ranged.longFt,
          },
        }
      : {}),
    saveProficiencies: character.proficiencies.saves,
    ...(spellAbility && useSpells
      ? { caster: { classId, level, slots: slotsMax } }
      : {}),
  };
  const full = maxUses(slug, level);
  const fresh = (): DayState => ({
    hp: maxHp,
    slotsUsed: mageArmor ? { '1': 1 } : {},
    rage: full.rage,
    secondWind: full.secondWind,
    actionSurge: full.actionSurge,
    layOnHands: full.layOnHands,
  });

  const rest: Pc['rest'] = (day, kind) => {
    if (kind === 'long') return fresh();
    // Short rest: spend half the Hit Dice (rounded up) at average value; features per SRD.
    const dice = Math.ceil(level / 2);
    const healed = dice * (Math.floor(klass.hitDie / 2) + 1 + conMod);
    return {
      ...day,
      hp: Math.min(maxHp, day.hp + healed),
      slotsUsed: slug === 'warlock' ? {} : day.slotsUsed,
      rage: Math.min(full.rage, day.rage + 1),
      secondWind: Math.min(full.secondWind, day.secondWind + 1),
      actionSurge: full.actionSurge,
    };
  };

  const best = (sim: Sim, e: SimEntity) => {
    const key = (f: SimEntity) =>
      policy === 'v2'
        ? f.hp - (dist(sim, e, f) <= 5 ? 1000 : 0)
        : dist(sim, e, f);
    return [...sim.opponents(e)].sort(
      (x, y) => key(x) - key(y) || x.id.localeCompare(y.id),
    )[0];
  };
  const dist = (sim: Sim, e: SimEntity, f: SimEntity) =>
    distance(e, f, sim.map.diagonalRule);

  // Per-fight bookkeeping that the sim does not track (smite slots, rage).
  let extraUsed: Record<string, number> = {};
  let raging = false;
  const slotLeft = (sim: Sim, day: DayState, lvl: number) =>
    (slotsMax[String(lvl)] ?? 0) -
    (day.slotsUsed[String(lvl)] ?? 0) -
    (extraUsed[String(lvl)] ?? 0) -
    (sim.get(spec.id).slotsUsed[String(lvl)] ?? 0);

  type Opt = { id: string; slot: number; score: number };
  const spellOptions = (sim: Sim, day: DayState, healing: boolean): Opt[] => {
    const opts: Opt[] = [];
    for (const s of spellPool([...cantrips, ...spells])) {
      if (
        healing !== !!s.healing ||
        (s.castingTime?.unit ?? 'action') !== 'action'
      )
        continue;
      for (let slot = s.level; slot <= (s.level === 0 ? 0 : maxSlot); slot++) {
        if (s.level > 0 && slotLeft(sim, day, slot) <= 0) continue;
        if (healing) {
          opts.push({ id: s.id, slot, score: avgDice(s.healing!.dice) + slot });
        } else {
          if (!s.damage?.length || s.concentration) continue;
          if (s.resolution?.kind !== 'attack' && s.resolution?.kind !== 'save')
            continue;
          opts.push({
            id: s.id,
            slot,
            score: expectedDamage(s, slot, level) - slot * 0.5,
          });
          if (s.level > 0) break; // lowest slot that casts it
        }
      }
    }
    return opts.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  };
  const cast = (sim: Sim, o: Opt, target: string) =>
    !('error' in sim.cast(spec.id, o.id, o.slot, { id: target }));

  const heal = (
    sim: Sim,
    e: SimEntity,
    day: DayState,
  ): 'action' | 'bonus' | null => {
    if (policy === 'v0' || e.hp > maxHp * 0.33) return null;
    if (slug === 'fighter' && day.secondWind > 0) {
      day.secondWind -= 1;
      sim.heal(e.id, Math.floor(avgDice('1d10')) + level);
      return 'bonus';
    }
    if (slug === 'paladin' && day.layOnHands > 0 && maxHp - e.hp >= 6) {
      const amt = Math.min(day.layOnHands, maxHp - e.hp);
      day.layOnHands -= amt;
      sim.heal(e.id, amt);
      return 'action';
    }
    if (spec.caster)
      for (const o of spellOptions(sim, day, true))
        if (cast(sim, o, e.id)) return 'action';
    return null;
  };

  const weaponAvg = () =>
    (avgDice(meleeDice) + meleeMod + (raging ? 2 : 0)) *
    0.65 *
    attacksPerAction;

  const turn: Pc['turn'] = (sim, e, day) => {
    if ((heal(sim, e, day) ?? '') === 'action') return;
    const attackOnce = (surge: boolean) => {
      const self = sim.get(spec.id);
      let target = best(sim, self);
      if (!target) return;
      if (spec.caster && policy !== 'v0') {
        const top = spellOptions(sim, day, false)[0];
        if (top && top.score > weaponAvg() && cast(sim, top, target.id)) return;
      }
      const shootable =
        !!kit.ranged &&
        sim.opponents(self).every((f) => dist(sim, self, f) > 5) &&
        dist(sim, self, target) <= kit.ranged.normalFt;
      if (!shootable && dist(sim, self, target) > 5) {
        if (surge) return;
        sim.approach(self);
        target = best(sim, sim.get(spec.id));
        if (!target || dist(sim, sim.get(spec.id), target) > 5) return;
      }
      const n = surge ? 1 : attacksPerAction;
      for (let i = 0; i < n; i++) {
        const t = best(sim, sim.get(spec.id));
        if (!t) return;
        const ranged = shootable && dist(sim, sim.get(spec.id), t) > 5;
        // Riders are folded into the flat bonus: the dice grammar allows one dice term.
        let riders = raging ? 2 : 0;
        let mode: 'normal' | 'advantage' = 'normal';
        let smiteSlot = 0;
        if (policy !== 'v0' && slug === 'rogue' && level >= 3) {
          mode = 'advantage'; // Steady Aim, which also enables Sneak Attack
          if (i === 0)
            riders += Math.round(avgDice(`${Math.ceil(level / 2)}d6`));
        }
        if (policy !== 'v0' && slug === 'paladin' && level >= 2 && i === 0) {
          for (let s = 1; s <= maxSlot && !smiteSlot; s++)
            if (slotLeft(sim, day, s) > 0) smiteSlot = s;
          if (smiteSlot) riders += Math.round(avgDice(`${1 + smiteSlot}d8`));
        }
        const over = ranged
          ? {
              attackBonus: rangedMod + pb,
              damage: dmg(kit.ranged!.dice, rangedMod + riders),
              mode,
            }
          : { ...meleeBonus(0, riders), mode };
        const r = ranged
          ? sim.shoot(spec.id, t.id, over)
          : sim.melee(spec.id, t.id, over);
        if ('hit' in r && r.hit && smiteSlot)
          extraUsed[String(smiteSlot)] =
            (extraUsed[String(smiteSlot)] ?? 0) + 1;
      }
    };
    attackOnce(false);
    if (policy !== 'v0' && slug === 'fighter' && day.actionSurge > 0) {
      day.actionSurge -= 1;
      attackOnce(true);
    }
    if (slug === 'monk' && policy !== 'v0') {
      const t = best(sim, sim.get(spec.id));
      if (t && dist(sim, sim.get(spec.id), t) <= 5)
        sim.melee(spec.id, t.id, {
          attackBonus: m(a, 'dex') + pb,
          damage: dmg(meleeDice, m(a, 'dex')),
        });
    }
  };

  const specFor: Pc['specFor'] = (day) => {
    extraUsed = {};
    raging = slug === 'barbarian' && policy !== 'v0' && day.rage > 0;
    const slots: Record<string, number> = {};
    for (const [k, v] of Object.entries(slotsMax))
      slots[k] = Math.max(0, v - (day.slotsUsed[k] ?? 0));
    return {
      ...spec,
      currentHp: day.hp,
      ...(raging
        ? {
            relations: {
              bludgeoning: 'resistant' as const,
              piercing: 'resistant' as const,
              slashing: 'resistant' as const,
            },
          }
        : {}),
      ...(spec.caster ? { caster: { ...spec.caster, slots } } : {}),
    };
  };
  const after: Pc['after'] = (sim, day) => {
    const e = sim.get(spec.id);
    const used = { ...day.slotsUsed };
    for (const [k, v] of Object.entries(e.slotsUsed))
      used[k] = (used[k] ?? 0) + v;
    for (const [k, v] of Object.entries(extraUsed))
      used[k] = (used[k] ?? 0) + v;
    return {
      ...day,
      rage: raging ? day.rage - 1 : day.rage,
      hp: e.status === 'dead' ? 0 : Math.max(0, e.hp),
      slotsUsed: used,
    };
  };

  return {
    slug,
    level,
    policy,
    spec,
    maxHp,
    hitDie: klass.hitDie,
    conMod,
    cantrips,
    spells,
    fresh,
    rest,
    specFor,
    turn,
    after,
  };
}
