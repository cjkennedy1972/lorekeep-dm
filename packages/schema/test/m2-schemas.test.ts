import { expect, test } from 'vitest';
import {
  DMToolArgsSchema,
  DMToolErrorCodeSchema,
  DMTurnEventSchema,
  EndpointConfigSchema,
} from '../src/index.js';

const valid = {
  request_check: {
    actorId: 'ent_ayla',
    ability: 'dex',
    dc: 15,
    dcReason: 'Loose gravel in dark corridor',
  },
  request_save: {
    actorId: 'ent_ayla',
    ability: 'wis',
    dc: 12,
    source: 'Goblin hex',
  },
  attack: {
    attackerId: 'ent_ayla',
    targetId: 'ent_gob2',
    attackId: 'srd:weapon/longsword',
  },
  cast_spell: {
    casterId: 'ent_ayla',
    spellId: 'srd:spell/fireball',
    slotLevel: 3,
    target: { kind: 'anchor', ref: 'feat_pillar1' },
  },
  apply_condition: {
    targetId: 'ent_gob2',
    conditionId: 'srd:condition/prone',
    source: 'Trip',
    duration: 'until-save',
  },
  remove_condition: {
    targetId: 'ent_gob2',
    conditionId: 'srd:condition/prone',
    source: 'Help',
    duration: 'until-removed',
  },
  start_combat: { enemies: [{ monsterId: 'srd:monster/goblin', count: 2 }] },
  end_combat: { outcome: 'party-victory' },
  move_to: { entityId: 'ent_ayla', targetRef: 'mk_altar', mode: 'cover' },
  suggest_area_target: {
    spellId: 'srd:spell/fireball',
    casterId: 'ent_ayla',
    intent: 'hit-target',
    focusRef: 'ent_gob2',
  },
  grant_item: { targetId: 'ent_ayla', itemId: 'srd:item/rope-hempen', qty: 1 },
  consume_item: {
    targetId: 'ent_ayla',
    itemId: 'srd:item/rope-hempen',
    qty: 1,
  },
  update_quest: { questId: 'quest_find-key', status: 'active' },
  upsert_npc: {
    id: 'npc_mira',
    name: 'Mira',
    role: 'Guide',
    disposition: 'friendly',
    facts: ['Knows the pass'],
  },
  upsert_location: {
    id: 'loc_pass',
    name: 'North Pass',
    role: 'Mountain pass',
    facts: ['Snow-covered'],
  },
  set_flag: { flagId: 'flag_gate_open', value: true },
  rules_lookup: { topic: 'cover rules' },
  log_ruling: { topic: 'Improvised lever', ruling: 'Use Athletics DC 12.' },
} as const;

test.each(Object.entries(valid))(
  '%s accepts valid args and rejects smuggling',
  (name, value) => {
    const schema = DMToolArgsSchema[name as keyof typeof DMToolArgsSchema];
    expect(schema.safeParse(value).success).toBe(true);
    for (const key of [
      'x',
      'y',
      'coordinate',
      'distance',
      'feet',
      'unexpected',
    ]) {
      expect(
        schema.safeParse({ ...value, [key]: 1 }).success,
        `${name} accepts ${key}`,
      ).toBe(false);
    }
    if ('actorId' in value)
      expect(
        schema.safeParse({ ...value, actorId: 'player-name' }).success,
      ).toBe(false);
    if ('casterId' in value)
      expect(
        schema.safeParse({ ...value, casterId: 'player-name' }).success,
      ).toBe(false);
    if ('entityId' in value)
      expect(
        schema.safeParse({ ...value, entityId: 'player-name' }).success,
      ).toBe(false);
  },
);

test('error enum is closed', () => {
  expect(DMToolErrorCodeSchema.safeParse('out-of-range').success).toBe(true);
  expect(DMToolErrorCodeSchema.safeParse('made-up-error').success).toBe(false);
});

test.each([
  {
    type: 'TurnStarted',
    turnId: 't1',
    seed: '0x4f2a91c7b3e05d18',
    promptPrefixHash: 'sha256:9c1f0123',
    inputs: [],
  },
  { type: 'NarrationChunk', turnId: 't1', text: 'The door opens.', index: 0 },
  {
    type: 'NarrationCompleted',
    turnId: 't1',
    text: 'The door opens.',
    words: 3,
  },
  { type: 'TurnReverted', turnId: 't2', revertedTurnId: 't1' },
  {
    type: 'ToolCallRejected',
    turnId: 't1',
    toolName: 'attack',
    error: 'out-of-range',
    attempt: 1,
    argHash: 'abc',
  },
  { type: 'SceneClosed', sceneId: 'scene1', summary: 'The party left.' },
  { type: 'RecapReady', sessionId: 'session1', recap: 'Previously...' },
  { type: 'TurnFallback', turnId: 't1', reason: 'no-narration' },
  { type: 'NarrationTruncated', turnId: 't1', words: 301 },
  {
    type: 'PromptOverBudget',
    turnId: 't1',
    tokens: 10001,
    trimsApplied: ['old transcript'],
  },
  { type: 'EntityDowned', entityId: 'ent_gob2', by: 'ent_ayla' },
  {
    type: 'TurnCommitted',
    turnId: 't1',
    eventSeqRange: [1, 3],
    usage: { in: 50, out: 10 },
  },
])('round trips $type', (event) =>
  expect(DMTurnEventSchema.parse(event)).toEqual(event),
);

test('client endpoint config excludes key material', () => {
  expect(
    EndpointConfigSchema.safeParse({
      profileId: 'p',
      toolMode: 'native',
      apiKey: 'secret',
    }).success,
  ).toBe(false);
});
