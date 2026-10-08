import { DMToolArgsSchema, type Battlemap } from '@game/schema';
import { abilityModifier } from '../dice.js';
import type { CharacterInput } from '../character/types.js';
import type { Catalog } from '../catalog/types.js';
import { startCombat, rollInitiative } from '../combat/commands.js';
import {
  apply,
  emptyCombatState,
  type CombatEvent,
  type CombatState,
} from '../combat/state.js';
import { rleDecode } from '@game/schema';
import type { GridPos } from '@game/schema';
import type { RngState } from '../rng.js';
import { fail, ok, type ToolResult } from './result.js';

const XP_BY_CR: Readonly<Record<number, number>> = {
  0: 10,
  0.125: 25,
  0.25: 50,
  0.5: 100,
  1: 200,
  2: 450,
  3: 700,
  4: 1100,
  5: 1800,
  6: 2300,
  7: 2900,
  8: 3900,
  9: 5000,
  10: 5900,
  11: 7200,
  12: 8400,
  13: 10000,
  14: 11500,
  15: 13000,
  16: 15000,
  17: 18000,
  18: 20000,
  19: 22000,
  20: 25000,
  21: 33000,
  22: 41000,
  23: 50000,
  24: 62000,
  25: 75000,
  26: 90000,
  27: 105000,
  28: 120000,
  29: 135000,
  30: 155000,
};
export type CombatEntity = {
  id: string;
  name: string;
  team: string;
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  dexterity: number;
  initiativeModifier: number;
  cr?: number;
};
export type CombatToolState = {
  actors: Readonly<Record<string, CharacterInput>>;
  catalog: Catalog;
  map?: Battlemap;
  entities?: readonly CombatEntity[];
  combat?: CombatState;
  xp?: Readonly<Record<string, number>>;
  encounterBudget?: number;
};
export type CombatToolOutput = {
  entities: CombatEntity[];
  combat: CombatState;
  xp: Record<string, number>;
  rng: RngState;
  warnings?: string[];
};
const crXp = (cr: number) => XP_BY_CR[cr];
function partyBudget(state: CombatToolState) {
  return (
    state.encounterBudget ??
    Object.values(state.actors).reduce(
      (sum, actor) => sum + actor.level * 25,
      0,
    )
  );
}
function spawnCells(map: Battlemap, ref?: string): GridPos[] {
  if (ref) {
    const zone = map.zones.find((candidate) => candidate.zoneId === ref);
    if (zone?.kind === 'spawn') return zone.cells;
    const marker = map.markers.find((candidate) => candidate.markerId === ref);
    if (marker) return [marker.cell];
    const feature = map.features.find(
      (candidate) => candidate.featureId === ref,
    );
    if (feature) return feature.cells;
    return [];
  }
  return map.zones
    .filter((zone) => zone.kind === 'spawn')
    .flatMap((zone) => zone.cells);
}
function openCell(
  map: Battlemap,
  entities: readonly CombatEntity[],
  cell: GridPos,
) {
  const tile = rleDecode(map.cells)[cell.y * map.w + cell.x];
  return (
    !map.palette[tile ?? 0]?.blocksMove &&
    !entities.some(
      (entity) =>
        cell.x < entity.pos.x + entity.size &&
        cell.x + 1 > entity.pos.x &&
        cell.y < entity.pos.y + entity.size &&
        cell.y + 1 > entity.pos.y,
    )
  );
}
export function executeStartCombat(
  state: CombatToolState,
  args: unknown,
  rng: RngState,
): ToolResult<CombatToolOutput> {
  const parsed = DMToolArgsSchema.start_combat.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid encounter arguments.',
    );
  if (state.combat && state.combat.combatants.length)
    return fail(
      'already-in-combat',
      'End the current combat before starting another.',
    );
  if (!state.map)
    return fail(
      'no-spawn-space',
      'Load a map with authored spawn zones before starting combat.',
    );
  const current = state.entities?.length
    ? [...state.entities]
    : Object.values(state.actors).map((actor) => ({
        id: actor.id,
        name: actor.name,
        team: 'party',
        pos: { x: -100, y: -100 },
        size: 1,
        hp: actor.hp.current,
        maxHp: actor.hp.max,
        ac: 10,
        speed: 30,
        dexterity: actor.abilities.dex,
        initiativeModifier: abilityModifier(actor.abilities.dex),
      }));
  const enemies: CombatEntity[] = [];
  for (const group of parsed.data.enemies) {
    const catalogId = group.monsterId.replace(/^srd:monster\//, 'monster:');
    const monster = state.catalog.get('monster', catalogId);
    if (!monster)
      return fail('unknown-monster', 'Choose a monster in the loaded catalog.');
    const defaultZone = state.map.zones.find(
      (zone) =>
        zone.kind === 'spawn' &&
        (zone.zoneId.includes('foe') || zone.zoneId.includes('enemy')),
    );
    const zoneCells = spawnCells(
      state.map,
      group.spawnRef ?? defaultZone?.zoneId,
    );
    for (let i = 0; i < group.count; i++) {
      const id = `ent_${monster.id.replace(/^monster:/, '').replace(/[^a-z0-9_-]/g, '_')}_${i + 1}`;
      if (current.some((e) => e.id === id) || enemies.some((e) => e.id === id))
        return fail(
          'no-spawn-space',
          'Generated enemy references collide with existing entities.',
        );
      const size = monster.footprint ?? 1;
      const fitting = zoneCells.find(
        (candidate) =>
          candidate.x + size <= state.map!.w &&
          candidate.y + size <= state.map!.h &&
          openCell(state.map!, [...current, ...enemies], candidate),
      );
      if (!fitting)
        return fail(
          'no-spawn-space',
          `No open ${size}x${size} spawn cell remains.`,
        );
      enemies.push({
        id,
        name: monster.name,
        team: 'enemies',
        pos: { ...fitting },
        size,
        hp: monster.hp,
        maxHp: monster.hp,
        ac: monster.ac,
        speed: monster.speed,
        dexterity: monster.abilities?.dex ?? 10,
        initiativeModifier:
          monster.initiative ?? abilityModifier(monster.abilities?.dex ?? 10),
        cr: monster.cr,
      });
    }
  }
  const all = [...current, ...enemies];
  const participants = all.map((entity) => ({
    id: entity.id,
    initiativeModifier: entity.initiativeModifier,
    speed: entity.speed,
  }));
  const started = startCombat(state.combat ?? emptyCombatState(), participants);
  if ('error' in started) return fail('schema-violation', started.hint);
  const rolled = rollInitiative(
    { ...emptyCombatState(), combatants: participants },
    rng,
  );
  if ('error' in rolled) return fail('schema-violation', rolled.hint);
  const events: CombatEvent[] = [...started.events, ...rolled.events];
  let combat = events.reduce(apply, emptyCombatState());
  const ambush = parsed.data.ambushSide ?? 'none';
  if (ambush !== 'none') {
    const preferred = all
      .filter(
        (entity) => entity.team === (ambush === 'party' ? 'party' : 'enemies'),
      )
      .map((e) => e.id);
    combat = {
      ...combat,
      initiative: [...combat.initiative].sort(
        (a, b) =>
          Number(!preferred.includes(a.entityId)) -
            Number(!preferred.includes(b.entityId)) ||
          combat.initiative.indexOf(a) - combat.initiative.indexOf(b),
      ),
    };
  }
  const budget = partyBudget(state);
  const threat = enemies.reduce(
    (sum, enemy) => sum + (crXp(enemy.cr ?? 0) ?? 0),
    0,
  );
  const warnings =
    threat > budget
      ? [`Encounter XP ${threat} exceeds the party budget ${budget}.`]
      : [];
  const entityEvents = all.map((entity) => ({
    type: 'EntityPlaced',
    entityId: entity.id,
    pos: entity.pos,
  }));
  return ok(
    {
      entities: all,
      combat,
      xp: { ...(state.xp ?? {}) },
      rng: rolled.events.length
        ? (rng + rolled.events.length * 0x6d2b79f5) >>> 0
        : rng,
      ...(warnings.length ? { warnings } : {}),
    },
    [
      ...events.map((event) => event.type),
      ...entityEvents.map((event) => event.type),
      ...(warnings.length ? ['EncounterBudgetWarning'] : []),
    ],
    `${enemies.length} enemies entered combat${warnings.length ? `; ${warnings[0]}` : ''}.`,
  );
}

export function executeEndCombat(
  state: CombatToolState,
  args: unknown,
): ToolResult<CombatToolOutput> {
  const parsed = DMToolArgsSchema.end_combat.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid combat outcome.',
    );
  if (!state.combat || !state.combat.combatants.length)
    return fail('not-in-combat', 'Start combat before ending it.');
  const active = (state.entities ?? []).filter(
    (e) => e.team === 'enemies' && e.hp > 0,
  );
  if (parsed.data.outcome === 'party-victory' && active.length)
    return fail(
      'enemies-still-active',
      `Resolve or remove active enemies first: ${active.map((e) => e.id).join(', ')}.`,
    );
  const earned =
    parsed.data.outcome === 'party-victory'
      ? (state.entities ?? [])
          .filter((e) => e.team === 'enemies')
          .reduce((sum, e) => sum + (crXp(e.cr ?? 0) ?? 0), 0)
      : 0;
  const xp = { ...(state.xp ?? {}) };
  const party = Object.values(state.actors);
  const share = Math.floor(earned / Math.max(1, party.length));
  let remainder = earned - share * party.length;
  for (const actor of party) {
    const award = share + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    xp[actor.id] = (xp[actor.id] ?? 0) + award;
  }
  const ended: CombatEvent = {
    type: 'CombatEnded',
    outcome: parsed.data.outcome,
    xp: earned,
  };
  const combat = apply(state.combat, ended);
  return ok(
    { entities: [...(state.entities ?? [])], combat, xp, rng: 0 },
    [ended.type, ...(earned ? ['XpAwarded'] : [])],
    earned
      ? `Combat ended; ${earned} XP awarded across ${party.length} party member(s).`
      : 'Combat ended without a victory XP award.',
  );
}
