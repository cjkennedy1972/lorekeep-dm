import { DMToolArgsSchema } from '@game/schema';
import type { GridPos } from '@game/schema';
import type { CharacterInput } from '../character/types.js';
import {
  castSpell,
  type SpellMapContext,
  type SpellTarget,
  type SpellState,
  type SpellEvent,
} from '../combat/spells.js';
import type { Catalog } from '../catalog/types.js';
import type { RngState } from '../rng.js';
import { fail, ok, turnHint, type ToolResult } from './result.js';

type AreaOption = { optionId: string; pos: GridPos; expiresTurn: string };
export type SpellToolState = {
  actors: Readonly<Record<string, CharacterInput>>;
  targets: Readonly<Record<string, SpellTarget>>;
  catalog: Catalog;
  map?: SpellMapContext;
  spellState?: SpellState;
  turnId: string;
  turnActorId?: string | null;
  options?: Readonly<Record<string, AreaOption>>;
};
const engineCode = (
  message: string,
):
  | 'unknown-spell'
  | 'not-known'
  | 'not-prepared'
  | 'no-slot-available'
  | 'slot-level-too-low'
  | 'concentration-conflict'
  | 'area-needs-anchor'
  | 'option-expired'
  | 'out-of-range'
  | 'no-line-of-sight' => {
  const m = message.toLowerCase();
  if (m.includes('unknown spell')) return 'unknown-spell';
  if (m.includes('not available')) return 'not-known';
  if (m.includes('slot'))
    return m.includes('no level') ? 'no-slot-available' : 'slot-level-too-low';
  if (m.includes('blocked')) return 'no-line-of-sight';
  if (m.includes('range')) return 'out-of-range';
  if (m.includes('anchor') || m.includes('area targeting'))
    return 'area-needs-anchor';
  return 'not-prepared';
};
export function executeSpell(
  state: SpellToolState,
  args: unknown,
  rng: RngState,
): ToolResult<{ events: SpellEvent[]; rng: RngState; state: SpellState }> {
  const parsed = DMToolArgsSchema.cast_spell.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid spell arguments.',
    );
  const { casterId, slotLevel, target: targetRef } = parsed.data;
  const spellId = parsed.data.spellId.replace(/^srd:spell\//, 'spell:');
  if (!state.catalog.get('spell', spellId))
    return fail('unknown-spell', 'Choose a spell in the loaded catalog.');
  const caster = state.actors[casterId];
  if (!caster)
    return fail('unknown-entity', 'Choose a caster present in the session.');
  if (state.turnActorId && state.turnActorId !== casterId)
    return fail('not-actors-turn', turnHint(state.turnActorId));
  if (
    !caster.spellsKnown.includes(spellId) &&
    !caster.spellsPrepared.includes(spellId)
  )
    return fail('not-known', 'Choose a spell known by the caster.');
  if (
    caster.spellsKnown.includes(spellId) &&
    caster.spellsPrepared.length &&
    !caster.spellsPrepared.includes(spellId)
  )
    return fail(
      'not-prepared',
      'Prepare this spell or choose one already prepared.',
    );
  let target: SpellTarget | { kind: 'anchor' | 'option'; pos: GridPos };
  if (targetRef.kind === 'self')
    target = state.targets[casterId] ?? {
      id: casterId,
      hp: caster.hp.current,
      maxHp: caster.hp.max,
      abilities: caster.abilities,
    };
  else if (targetRef.kind === 'entity') {
    const entity = state.targets[targetRef.ref];
    if (!entity)
      return fail('unknown-entity', 'Choose a placed target entity.');
    target = entity;
  } else if (targetRef.kind === 'anchor') {
    const marker = state.map?.map.markers.find(
      (item) => item.markerId === targetRef.ref,
    );
    const feature = state.map?.map.features.find(
      (item) => item.featureId === targetRef.ref,
    );
    const cell = marker?.cell ?? feature?.cells[0];
    if (!cell)
      return fail(
        'area-needs-anchor',
        'Choose a valid map marker or feature as the area anchor.',
      );
    target = { kind: 'anchor', pos: cell };
  } else {
    const option = state.options?.[targetRef.ref];
    if (!option || option.expiresTurn !== state.turnId)
      return fail(
        'option-expired',
        'Request fresh area targeting options, then use one of those option IDs this turn.',
      );
    target = { kind: 'option', pos: option.pos };
  }
  if ('kind' in target && !state.map)
    return fail(
      'area-needs-anchor',
      'This area target requires an active map.',
    );
  const result = castSpell({
    caster,
    target,
    spellId,
    slotLevel,
    seed: rng,
    catalog: state.catalog,
    ...(state.map ? { map: state.map } : {}),
    ...(state.spellState ? { state: state.spellState } : {}),
  });
  if ('error' in result) return fail(engineCode(result.error), result.hint);
  const events = result.events.map((event) => event.type);
  return ok(
    { events: result.events, rng: result.rng, state: result.state },
    events,
    `${caster.name} casts ${spellId.replace('srd:spell/', '').replaceAll('-', ' ')}.`,
  );
}
