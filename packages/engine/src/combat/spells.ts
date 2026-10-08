import type { Ability, CatalogEntry } from '@game/schema';
import type { CharacterInput } from '../character/types.js';
import type { Catalog } from '../catalog/types.js';
import {
  abilityModifier,
  proficiencyBonus,
  roll,
  type RollBreakdown,
  type RollMode,
} from '../dice.js';
import type { RngState } from '../rng.js';
import type { Battlemap, GridPos } from '@game/schema';
import { distance, type Placed } from '../map/geometry.js';
import { areaCells, affectedEntities, type AreaShape } from '../map/area.js';
import { coverBetween } from '../map/cover.js';
import { hasLineOfSight } from '../map/los.js';

export type SpellTarget = {
  id: string;
  hp: number;
  maxHp: number;
  ac?: number;
  abilities: Record<Ability, number>;
  proficiencies?: { saves?: Ability[] };
  conditions?: readonly { conditionId: string }[];
};
export type SpellEvent =
  | { type: 'AreaResolved'; cells: GridPos[]; affected: string[] }
  | { type: 'SlotSpent'; entityId: string; slotLevel: number }
  | { type: 'SpellCast'; entityId: string; spellId: string; slotLevel: number }
  | { type: 'ConcentrationStarted'; entityId: string; spellId: string }
  | { type: 'ConcentrationDropped'; entityId: string; spellId: string }
  | {
      type: 'RollEvent';
      entityId: string;
      spellId: string;
      kind: 'attack' | 'save' | 'damage' | 'healing';
      breakdown: RollBreakdown;
    }
  | {
      type: 'HpChanged';
      entityId: string;
      from: number;
      to: number;
      amount: number;
      kind: 'damage' | 'healing';
      damageType?: string;
    }
  | { type: 'AreaResolved'; cells: GridPos[]; affected: string[] };
export type SpellState = {
  concentration: Record<string, string | null>;
  hp: Record<string, number>;
  slots: Record<string, Record<string, { max: number; used: number }>>;
};
export type SpellMapContext = {
  map: Battlemap;
  caster: Placed;
  /** Complete combat placements. A missing id in targets is treated as a blocked target. */
  entities: readonly (Placed & { id: string })[];
  targets: readonly SpellTarget[];
  /** Anchor is the point target for an area spell; defaults to caster position. */
  anchor?: GridPos;
  direction?: GridPos;
};
export type CastSpellInput = {
  caster: CharacterInput;
  target: SpellTarget | { kind: 'anchor' | 'option'; pos: GridPos };
  map?: SpellMapContext;
  spellId: string;
  slotLevel: number;
  seed: RngState;
  catalog: Catalog;
  state?: SpellState;
  mode?: RollMode;
  targetSaveProficiency?: number;
};
export type CastSpellResult =
  | {
      ok: true;
      events: SpellEvent[];
      rng: RngState;
      state: SpellState;
      attackHit?: boolean;
      saveSucceeded?: boolean;
    }
  | { error: string; hint: string };

const fail = (error: string, hint: string): CastSpellResult => ({
  error,
  hint,
});
const scaledDamage = (
  d: NonNullable<Extract<CatalogEntry, { kind: 'spell' }>['damage']>[number],
  spellLevel: number,
  slotLevel: number,
  casterLevel: number,
) => {
  let dice = d.dice;
  let count = d.count ?? 1;
  const cantripIndex =
    casterLevel >= 17 ? 2 : casterLevel >= 11 ? 1 : casterLevel >= 5 ? 0 : -1;
  if (spellLevel === 0 && cantripIndex >= 0) {
    dice = d.scaling?.cantrip?.dice?.[cantripIndex] ?? dice;
    count = d.scaling?.cantrip?.count?.[cantripIndex] ?? count;
  } else if (slotLevel > spellLevel) {
    const steps = slotLevel - spellLevel;
    if (d.scaling?.slot?.dice) {
      const base = d.dice.match(/^(\d+d\d+)([+-]\d+)?$/i)!;
      const extra = d.scaling.slot.dice.match(/^(\d+d\d+)([+-]\d+)?$/i)!;
      const [bc, bs] = base[1]!.split('d').map(Number);
      const [ec, es] = extra[1]!.split('d').map(Number);
      if (bs === es) {
        const modifier = Number(base[2] ?? 0) + Number(extra[2] ?? 0) * steps;
        dice = `${bc! + ec! * steps}d${bs}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`;
      } else {
        const modifier = Number(base[2] ?? 0) + Number(extra[2] ?? 0) * steps;
        dice = `${bc!}d${bs}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`;
      }
    }
    count += (d.scaling?.slot?.count ?? 0) * steps;
  }
  return { dice, count };
};

export function castSpell(input: CastSpellInput): CastSpellResult {
  const { caster, spellId, slotLevel, catalog } = input;
  const isAreaTarget =
    typeof input.target === 'object' && 'kind' in input.target;
  const target: SpellTarget = isAreaTarget
    ? (input.map?.targets[0] ?? {
        id: '__area__',
        hp: 0,
        maxHp: 0,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      })
    : (input.target as SpellTarget);
  const spell = catalog.get('spell', spellId);
  if (!spell)
    return fail(
      `Unknown spell ${spellId}.`,
      'Choose a spell in the loaded catalog.',
    );
  const klass = catalog.get('class', caster.classId);
  if (
    !klass?.spellcastingAbility ||
    !spell.classes.includes(klass.name.toLowerCase())
  )
    return fail(
      `${spell.name} is not available to this class.`,
      'Choose a spell on the caster’s class list.',
    );
  if (!Number.isInteger(slotLevel) || slotLevel < spell.level || slotLevel > 9)
    return fail(
      'Invalid spell slot level.',
      `Cast at level ${spell.level} or higher.`,
    );
  const slot = caster.slots[String(slotLevel)];
  if (spell.level > 0 && (!slot || slot.used >= slot.max))
    return fail(
      `No level ${slotLevel} spell slot available.`,
      'Choose an available slot of sufficient level.',
    );
  const resolution = spell.resolution;
  const area = isAreaTarget && spell.template ? spell.template : undefined;
  if (isAreaTarget && (!input.map || !area))
    return fail(
      'Area targeting requires a mapped spell template.',
      'Supply a map and use a spell with an area template.',
    );
  if (input.map && !isAreaTarget && input.target && !('kind' in input.target)) {
    const placement = input.map.entities.find((e) => e.id === target.id);
    if (!placement)
      return fail('Target has no map position.', 'Choose a placed target.');
    const dist = distance(
      input.map.caster,
      placement,
      input.map.map.diagonalRule,
    );
    if (
      !hasLineOfSight(input.map.map, input.map.caster, placement) ||
      !coverBetween(input.map.map, input.map.caster, placement).targetable
    )
      return fail(
        'Target is blocked by full cover.',
        'Choose a target with line of sight.',
      );
    if (spell.range?.kind === 'feet' && dist > spell.range.feet)
      return fail('Target is beyond spell range.', 'Choose a closer target.');
  }
  if (!resolution || resolution.kind === 'utility')
    return fail(
      'This spell has no supported single-target resolution.',
      'Choose an attack, save, auto, or healing spell.',
    );
  if (spell.level === 0 && slotLevel !== 0)
    return fail(
      'Cantrips do not use spell slots.',
      'Cast this cantrip at level 0.',
    );
  if (spell.level > 0 && slotLevel === 0)
    return fail(
      'A leveled spell requires a spell slot.',
      'Choose an available slot of sufficient level.',
    );

  const provided = input.state ?? {
    concentration: {},
    hp: { [caster.id]: caster.hp.current, [target.id]: target.hp },
    slots: {},
  };
  const stateStart: SpellState = {
    concentration: { ...provided.concentration },
    hp: { ...provided.hp },
    slots: {
      ...provided.slots,
      [caster.id]: { ...(provided.slots[caster.id] ?? caster.slots) },
    },
  };
  const events: SpellEvent[] = [];
  const areaTargets =
    area && input.map
      ? (() => {
          const anchor =
            isAreaTarget && 'pos' in input.target
              ? input.target.pos
              : (input.map!.anchor ?? input.map!.caster.pos);
          const cells = areaCells(
            input.map!.map,
            {
              shape: area.shape as AreaShape,
              size: area.size,
              width: area.width,
              height: area.height,
            },
            anchor,
            input.map!.direction,
          );
          const affected = affectedEntities(
            cells,
            { map: input.map!.map, entities: input.map!.entities },
            anchor,
          )
            .filter((e) => !(area.shape === 'cone' && e.id === caster.id))
            .filter((e) =>
              hasLineOfSight(
                input.map!.map,
                { pos: anchor, size: 1 },
                input.map!.entities.find((p) => p.id === e.id)!,
              ),
            );
          return {
            anchor,
            cells,
            affected,
            targets: affected
              .map((e) => input.map!.targets.find((t) => t.id === e.id))
              .filter((t): t is SpellTarget => !!t),
          };
        })()
      : undefined;
  if (spell.level > 0)
    events.push({ type: 'SlotSpent', entityId: caster.id, slotLevel });
  events.push({ type: 'SpellCast', entityId: caster.id, spellId, slotLevel });
  const previous = stateStart.concentration[caster.id];
  if (spell.concentration && previous)
    events.push({
      type: 'ConcentrationDropped',
      entityId: caster.id,
      spellId: previous,
    });
  if (spell.concentration)
    events.push({ type: 'ConcentrationStarted', entityId: caster.id, spellId });

  let rng = input.seed;
  let attackHit: boolean | undefined;
  let saveSucceeded: boolean | undefined;
  const ability = klass.spellcastingAbility;
  const spellAttackBonus =
    abilityModifier(caster.abilities[ability]) + proficiencyBonus(caster.level);
  if (areaTargets) {
    for (const affected of areaTargets.affected) {
      const victim = input.map!.targets.find((t) => t.id === affected.id);
      if (!victim) continue;
      const save = resolution.kind === 'save' ? resolution : undefined;
      let saveSucceeded = false;
      if (save) {
        const dc =
          8 +
          proficiencyBonus(caster.level) +
          abilityModifier(caster.abilities[ability]);
        const bonus =
          abilityModifier(victim.abilities[save.ability]) +
          (save.ability === 'dex' ? affected.saveBonus : 0) +
          (victim.proficiencies?.saves?.includes(save.ability)
            ? (input.targetSaveProficiency ?? proficiencyBonus(caster.level))
            : 0);
        const [saveRoll, next] = roll('1d20', rng, {
          modifiers: [{ label: save.ability, value: bonus }],
        });
        rng = next;
        events.push({
          type: 'RollEvent',
          entityId: victim.id,
          spellId,
          kind: 'save',
          breakdown: saveRoll,
        });
        saveSucceeded = saveRoll.total >= dc;
      }
      if (resolution.kind === 'save')
        for (const d of spell.damage ?? []) {
          const scaled = scaledDamage(d, spell.level, slotLevel, caster.level);
          for (let n = 0; n < scaled.count; n++) {
            const [breakdown, next] = roll(scaled.dice, rng);
            rng = next;
            events.push({
              type: 'RollEvent',
              entityId: caster.id,
              spellId,
              kind: 'damage',
              breakdown,
            });
            const half = saveSucceeded && resolution.onSuccess === 'half';
            const amount = Math.floor(
              Math.max(0, breakdown.total) *
                (half ? 0.5 : saveSucceeded ? 0 : 1),
            );
            const from = stateStart.hp[victim.id] ?? victim.hp;
            const to = Math.max(0, from - amount);
            events.push({
              type: 'HpChanged',
              entityId: victim.id,
              from,
              to,
              amount: from - to,
              kind: 'damage',
              damageType: d.types[0],
            });
          }
        }
    }
    events.push({
      type: 'AreaResolved',
      cells: areaTargets.cells,
      affected: areaTargets.affected
        .filter((e) => input.map!.targets.some((t) => t.id === e.id))
        .map((e) => e.id),
    });
  } else if (resolution.kind === 'attack') {
    const [attackRoll, next] = roll('1d20', rng, {
      mode: input.mode,
      modifiers: [{ label: 'spell attack', value: spellAttackBonus }],
    });
    rng = next;
    events.push({
      type: 'RollEvent',
      entityId: caster.id,
      spellId,
      kind: 'attack',
      breakdown: attackRoll,
    });
    const natural = attackRoll.dice.find((d) => d.kept)!.value;
    attackHit =
      natural !== 1 &&
      (natural === 20 || attackRoll.total >= (target.ac ?? 10));
    if (attackHit && resolution.alsoSave) {
      const save = resolution.alsoSave;
      const dc =
        8 +
        proficiencyBonus(caster.level) +
        abilityModifier(caster.abilities[ability]);
      const bonus =
        abilityModifier(target.abilities[save.ability]) +
        (target.proficiencies?.saves?.includes(save.ability)
          ? (input.targetSaveProficiency ?? proficiencyBonus(caster.level))
          : 0);
      const [saveRoll, nextSave] = roll('1d20', rng, {
        modifiers: [{ label: save.ability, value: bonus }],
      });
      rng = nextSave;
      events.push({
        type: 'RollEvent',
        entityId: target.id,
        spellId,
        kind: 'save',
        breakdown: saveRoll,
      });
      saveSucceeded = saveRoll.total >= dc;
    }
  } else if (resolution.kind === 'save') {
    const save = resolution;
    const dc =
      8 +
      proficiencyBonus(caster.level) +
      abilityModifier(caster.abilities[ability]);
    const bonus =
      abilityModifier(target.abilities[save.ability]) +
      (target.proficiencies?.saves?.includes(save.ability)
        ? (input.targetSaveProficiency ?? proficiencyBonus(caster.level))
        : 0);
    const [saveRoll, next] = roll('1d20', rng, {
      modifiers: [{ label: save.ability, value: bonus }],
    });
    rng = next;
    events.push({
      type: 'RollEvent',
      entityId: target.id,
      spellId,
      kind: 'save',
      breakdown: saveRoll,
    });
    saveSucceeded = saveRoll.total >= dc;
  }
  const hasEffect = !areaTargets && (resolution.kind !== 'attack' || attackHit);
  if (hasEffect)
    for (const d of spell.damage ?? []) {
      const scaled = scaledDamage(d, spell.level, slotLevel, caster.level);
      for (let n = 0; n < scaled.count; n++) {
        const [breakdown, next] = roll(scaled.dice, rng);
        rng = next;
        events.push({
          type: 'RollEvent',
          entityId: caster.id,
          spellId,
          kind: 'damage',
          breakdown,
        });
        const half =
          resolution.kind === 'save' &&
          saveSucceeded &&
          resolution.onSuccess === 'half';
        const amount = Math.floor(
          Math.max(0, breakdown.total) / (half ? 2 : 1),
        );
        const from =
          [...events]
            .reverse()
            .find(
              (e): e is Extract<SpellEvent, { type: 'HpChanged' }> =>
                e.type === 'HpChanged' && e.entityId === target.id,
            )?.to ??
          stateStart.hp[target.id] ??
          target.hp;
        const to = Math.max(0, from - amount);
        events.push({
          type: 'HpChanged',
          entityId: target.id,
          from,
          to,
          amount,
          kind: 'damage',
          damageType: d.types[0],
        });
      }
    }
  if (hasEffect && spell.healing) {
    const expr =
      slotLevel > spell.level && spell.healing.slotDice
        ? (() => {
            const base = /^(\d+)d(\d+)([+-]\d+)?$/i.exec(spell.healing.dice)!;
            const extra = /^(\d+)d(\d+)([+-]\d+)?$/i.exec(
              spell.healing.slotDice!,
            )!;
            const steps = slotLevel - spell.level;
            const count = Number(base[1]) + Number(extra[1]) * steps;
            const modifier =
              Number(base[3] ?? 0) + Number(extra[3] ?? 0) * steps;
            return `${count}d${base[2]}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`;
          })()
        : spell.healing.dice;
    const [breakdown, next] = roll(expr, rng, {
      modifiers: spell.healing.addsModifier
        ? [
            {
              label: 'spellcasting ability',
              value: abilityModifier(caster.abilities[ability]),
            },
          ]
        : [],
    });
    rng = next;
    events.push({
      type: 'RollEvent',
      entityId: caster.id,
      spellId,
      kind: 'healing',
      breakdown,
    });
    const from =
      [...events]
        .reverse()
        .find(
          (e): e is Extract<SpellEvent, { type: 'HpChanged' }> =>
            e.type === 'HpChanged' && e.entityId === target.id,
        )?.to ??
      stateStart.hp[target.id] ??
      target.hp;
    const to = Math.min(target.maxHp, from + Math.max(0, breakdown.total));
    const event: SpellEvent = {
      type: 'HpChanged',
      entityId: target.id,
      from,
      to,
      amount: to - from,
      kind: 'healing',
    };
    events.push(event);
  }
  const state = replaySpells(stateStart, events);
  return {
    ok: true,
    events,
    rng,
    state,
    ...(attackHit === undefined ? {} : { attackHit }),
    ...(saveSucceeded === undefined ? {} : { saveSucceeded }),
  };
}

export function applySpellEvent(
  state: SpellState,
  event: SpellEvent,
): SpellState {
  switch (event.type) {
    case 'SlotSpent': {
      const slot = state.slots[event.entityId]?.[String(event.slotLevel)];
      if (!slot || slot.used >= slot.max)
        throw new Error(`No slot to spend for ${event.entityId}`);
      return {
        ...state,
        slots: {
          ...state.slots,
          [event.entityId]: {
            ...state.slots[event.entityId],
            [String(event.slotLevel)]: { ...slot, used: slot.used + 1 },
          },
        },
      };
    }
    case 'ConcentrationDropped':
      return {
        ...state,
        concentration: { ...state.concentration, [event.entityId]: null },
      };
    case 'ConcentrationStarted':
      return {
        ...state,
        concentration: {
          ...state.concentration,
          [event.entityId]: event.spellId,
        },
      };
    case 'HpChanged':
      return { ...state, hp: { ...state.hp, [event.entityId]: event.to } };
    case 'AreaResolved':
    case 'SpellCast':
    case 'RollEvent':
      return state;
  }
}
export const replaySpells = (
  start: SpellState,
  events: readonly SpellEvent[],
) => events.reduce(applySpellEvent, start);

export type ConcentrationSaveResult =
  | { ok: true; success: boolean; events: SpellEvent[]; rng: RngState }
  | { error: string; hint: string };
export function concentrationSave(
  entityId: string,
  damage: number,
  constitution: number,
  seed: RngState,
  state: SpellState,
): ConcentrationSaveResult {
  const spellId = state.concentration[entityId];
  if (!spellId)
    return {
      error: 'Not concentrating on a spell.',
      hint: 'A concentration save is only needed while concentrating.',
    };
  const dc = Math.max(10, Math.floor(damage / 2));
  const [breakdown, rng] = roll('1d20', seed, {
    modifiers: [{ label: 'constitution', value: constitution }],
  });
  const events: SpellEvent[] = [
    { type: 'RollEvent', entityId, spellId, kind: 'save', breakdown },
  ];
  const success = breakdown.total >= dc;
  if (!success)
    events.push({ type: 'ConcentrationDropped', entityId, spellId });
  return { ok: true, success, events, rng };
}
