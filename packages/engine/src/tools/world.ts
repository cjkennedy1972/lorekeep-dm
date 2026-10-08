import {
  DMToolArgsSchema,
  NpcSchema,
  LocationSchema,
  QuestSchema,
  FlagSchema,
  RulingSchema,
  type DMToolErrorCode,
} from '@game/schema';
import type { Catalog } from '../catalog/types.js';
import type { CharacterInput } from '../character/types.js';

export type WorldRegistry = {
  npcs: Record<
    string,
    {
      id: string;
      name: string;
      role: string;
      disposition: 'hostile' | 'unfriendly' | 'neutral' | 'friendly' | 'ally';
      facts: string[];
    }
  >;
  locations: Record<
    string,
    { id: string; name: string; role: string; facts: string[] }
  >;
  quests: Record<
    string,
    {
      id: string;
      status: 'available' | 'active' | 'completed' | 'failed';
      note?: string;
    }
  >;
  flags: Record<string, { id: string; value: boolean | string | number }>;
  rulings: { id: string; topic: string; ruling: string }[];
};
export type WorldEvent =
  | {
      type: 'ItemGranted' | 'ItemConsumed';
      entityId: string;
      itemId: string;
      qty: number;
    }
  | { type: 'QuestUpdated'; quest: WorldRegistry['quests'][string] }
  | { type: 'NpcUpserted'; npc: WorldRegistry['npcs'][string] }
  | { type: 'LocationUpserted'; location: WorldRegistry['locations'][string] }
  | { type: 'FlagSet'; flag: WorldRegistry['flags'][string] }
  | { type: 'RulingLogged'; ruling: WorldRegistry['rulings'][number] };
export type WorldResult<T> =
  | { ok: true; value: T; events: WorldEvent[]; summary: string }
  | { ok: false; error: DMToolErrorCode; hint: string };
const ok = <T>(
  value: T,
  events: WorldEvent[],
  summary: string,
): WorldResult<T> => ({
  ok: true,
  value,
  events,
  summary: summary.slice(0, 200),
});
const fail = (error: DMToolErrorCode, hint: string): WorldResult<never> => ({
  ok: false,
  error,
  hint,
});
const immutable = <T extends { facts: string[] }>(
  old: T | undefined,
  next: T,
): boolean => !!old && old.facts.some((fact) => !next.facts.includes(fact));

export function grantItem(
  character: CharacterInput,
  itemId: string,
  qty: number,
  catalog: Catalog,
  options: { lootBudgetRemaining?: number } = {},
): WorldResult<CharacterInput> {
  const parsed = DMToolArgsSchema.grant_item.safeParse({
    targetId: /^ent_[a-z0-9_-]{1,32}$/.test(character.id)
      ? character.id
      : 'ent_character',
    itemId,
    qty,
  });
  if (itemId.startsWith('srd:currency/') && itemId !== 'srd:currency/gp')
    return fail(
      'unknown-item',
      'The only supported currency is srd:currency/gp.',
    );
  if (itemId === 'srd:currency/gp' && Number.isInteger(qty) && qty > 0) {
    const allowed = options.lootBudgetRemaining;
    if (allowed === undefined || qty > allowed)
      return fail(
        'loot-budget-exceeded',
        `At most ${Math.max(0, allowed ?? 0)} gp remains in this encounter loot budget.`,
      );
  }
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ??
        'Use a catalog item and positive quantity.',
    );
  if (itemId.startsWith('srd:currency/')) {
    const allowed = options.lootBudgetRemaining;
    return ok(
      character,
      [{ type: 'ItemGranted', entityId: character.id, itemId, qty }],
      `Granted ${qty} gp (remaining loot allowance: ${Math.max(0, (allowed ?? qty) - qty)}).`,
    );
  }
  const catalogId = itemId.replace(/^srd:item\//, 'equipment:');
  const entry = catalog.getAny(catalogId);
  if (!entry || entry.kind !== 'equipment')
    return fail(
      'unknown-item',
      `Choose an item in the catalog: ${catalog.entries
        .filter((e) => e.kind === 'equipment')
        .slice(0, 10)
        .map((e) => `srd:item/${e.id.replace(/^equipment:/, '')}`)
        .join(', ')}.`,
    );
  const equipment = [...character.equipment];
  const existing = equipment.find((item) => item.itemId === catalogId);
  if (existing) existing.qty += qty;
  else equipment.push({ itemId: catalogId, qty, equipped: false });
  return ok(
    { ...character, equipment },
    [{ type: 'ItemGranted', entityId: character.id, itemId, qty }],
    `Granted ${qty} ${entry.name}.`,
  );
}

export function consumeItem(
  character: CharacterInput,
  itemId: string,
  qty: number,
  catalog: Catalog,
): WorldResult<CharacterInput> {
  const parsed = DMToolArgsSchema.consume_item.safeParse({
    targetId: /^ent_[a-z0-9_-]{1,32}$/.test(character.id)
      ? character.id
      : 'ent_character',
    itemId,
    qty,
  });
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ??
        'Use a catalog item and positive quantity.',
    );
  const catalogId = itemId.startsWith('srd:item/')
    ? itemId.replace(/^srd:item\//, 'equipment:')
    : undefined;
  if (!catalogId || catalog.getAny(catalogId)?.kind !== 'equipment')
    return fail('unknown-item', 'Choose an item from the equipment catalog.');
  const existing = character.equipment.find(
    (item) => item.itemId === catalogId,
  );
  if (!existing)
    return fail('not-in-inventory', `The character does not carry ${itemId}.`);
  if (existing.qty < qty)
    return fail(
      'insufficient-qty',
      `Only ${existing.qty} are carried; consume no more than that.`,
    );
  const equipment = character.equipment.flatMap((item) =>
    item.itemId !== catalogId
      ? [item]
      : item.qty === qty
        ? []
        : [{ ...item, qty: item.qty - qty }],
  );
  return ok(
    { ...character, equipment },
    [{ type: 'ItemConsumed', entityId: character.id, itemId, qty }],
    `Consumed ${qty} ${catalog.getAny(catalogId)!.name}.`,
  );
}

export type RegistryDiff<K extends string, T> = {
  kind: K;
  id: string;
  before?: T;
  after: T;
};
export function upsertNpc(
  registry: WorldRegistry,
  input: unknown,
): WorldResult<RegistryDiff<'npc', WorldRegistry['npcs'][string]>> {
  const parsed = DMToolArgsSchema.upsert_npc.safeParse(input);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid NPC.',
    );
  const after = NpcSchema.parse(parsed.data);
  const before = registry.npcs[after.id];
  if (immutable(before, after))
    return fail(
      'fact-immutable',
      'Do not rewrite an existing fact; append a new fact that explicitly supersedes it.',
    );
  return ok(
    { kind: 'npc', id: after.id, ...(before ? { before } : {}), after },
    [{ type: 'NpcUpserted', npc: after }],
    `Recorded ${after.name}.`,
  );
}
export function upsertLocation(
  registry: WorldRegistry,
  input: unknown,
): WorldResult<RegistryDiff<'location', WorldRegistry['locations'][string]>> {
  const parsed = DMToolArgsSchema.upsert_location.safeParse(input);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid location.',
    );
  const after = LocationSchema.parse(parsed.data);
  const before = registry.locations[after.id];
  if (immutable(before, after))
    return fail(
      'fact-immutable',
      'Do not rewrite an existing fact; append a new fact that explicitly supersedes it.',
    );
  return ok(
    { kind: 'location', id: after.id, ...(before ? { before } : {}), after },
    [{ type: 'LocationUpserted', location: after }],
    `Recorded ${after.name}.`,
  );
}
export function updateQuest(
  registry: WorldRegistry,
  input: unknown,
): WorldResult<RegistryDiff<'quest', WorldRegistry['quests'][string]>> {
  const parsed = DMToolArgsSchema.update_quest.safeParse(input);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid quest update.',
    );
  const before = registry.quests[parsed.data.questId];
  if (!before)
    return fail(
      'unknown-quest',
      `Create ${parsed.data.questId} before updating it.`,
    );
  if (
    (before.status === 'completed' || before.status === 'failed') &&
    before.status !== parsed.data.status
  )
    return fail(
      'illegal-transition',
      'Completed and failed quests are terminal; create a new quest to continue the story.',
    );
  const after = QuestSchema.parse({
    id: parsed.data.questId,
    status: parsed.data.status,
    ...(parsed.data.note === undefined
      ? before.note === undefined
        ? {}
        : { note: before.note }
      : { note: parsed.data.note }),
  });
  return ok(
    { kind: 'quest', id: after.id, before, after },
    [{ type: 'QuestUpdated', quest: after }],
    `Quest ${after.id} is now ${after.status}.`,
  );
}
export function setFlag(
  registry: WorldRegistry,
  input: unknown,
): WorldResult<RegistryDiff<'flag', WorldRegistry['flags'][string]>> {
  const parsed = DMToolArgsSchema.set_flag.safeParse(input);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid flag.',
    );
  const after = FlagSchema.parse({
    id: parsed.data.flagId,
    value: parsed.data.value,
  });
  const before = registry.flags[after.id];
  return ok(
    { kind: 'flag', id: after.id, ...(before ? { before } : {}), after },
    [{ type: 'FlagSet', flag: after }],
    `Updated ${after.id}.`,
  );
}
export function logRuling(
  registry: WorldRegistry,
  input: unknown,
): WorldResult<RegistryDiff<'ruling', WorldRegistry['rulings'][number]>> {
  const parsed = DMToolArgsSchema.log_ruling.safeParse(input);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide a valid ruling.',
    );
  const id = `ruling_${
    parsed.data.topic
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'general'
  }`;
  const after = RulingSchema.parse({
    id,
    topic: parsed.data.topic,
    ruling: parsed.data.ruling,
  });
  const before = registry.rulings.find((entry) => entry.id === id);
  return ok(
    { kind: 'ruling', id, ...(before ? { before } : {}), after },
    [{ type: 'RulingLogged', ruling: after }],
    `Recorded ruling for ${after.topic}.`,
  );
}

export function findRulings(
  registry: WorldRegistry,
  topic: string,
): WorldRegistry['rulings'] {
  const needle = topic.toLocaleLowerCase();
  return registry.rulings.filter(
    (ruling) =>
      ruling.topic.toLocaleLowerCase().includes(needle) ||
      ruling.ruling.toLocaleLowerCase().includes(needle),
  );
}
