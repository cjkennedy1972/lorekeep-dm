import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_ID_RULES,
  WIRE_MESSAGE_RULES,
  reactionPromptVisibleTo,
  projectEventForViewer,
} from '../../src/room/eventVisibility.js';

const hidden = new Set(['rogue']);
const none = new Set<string>();
const owner = new Set(['rogue']);

// One sample per declared event type, naming the hidden id in every id field.
const samples: Record<string, Record<string, unknown>> = {
  CombatStarted: {
    order: ['pc', 'rogue'],
    combatants: [
      { id: 'pc', pos: { x: 1, y: 1 } },
      { id: 'rogue', pos: { x: 7, y: 9 } },
    ],
  },
  AreaResolved: { cells: [{ x: 1, y: 1 }], affected: ['pc', 'rogue'] },
  RollEvent: { entityId: 'pc', actorId: 'rogue' },
  OpportunityTriggered: { moverId: 'pc', attackerId: 'rogue' },
  MonsterPolicy: { monsterId: 'rogue' },
  AttackRefused: { entityId: 'pc', attackerId: 'pc', targetId: 'rogue' },
};

describe('schema-driven combat event visibility', () => {
  it('EntityRevealed is visible to every viewer even while the id remains concealed historically', () => {
    const reveal = { type: 'EntityRevealed', entityId: 'rogue', cause: 'bump' };
    expect(projectEventForViewer(reveal, hidden, none)).toEqual(reveal);
    expect(projectEventForViewer(reveal, hidden, owner)).toEqual(reveal);
  });
  for (const [type, rule] of Object.entries(EVENT_ID_RULES)) {
    const idFields = [...(rule.scalars ?? []), ...(rule.lists ?? [])];
    if (idFields.length === 0) continue;
    it(`${type}: hidden entity never reaches a non-controller, controller keeps it`, () => {
      const event = {
        type,
        ...Object.fromEntries((rule.scalars ?? []).map((k) => [k, 'rogue'])),
        ...(samples[type] ?? {
          ...(rule.lists
            ? Object.fromEntries(rule.lists.map((k) => [k, ['pc', 'rogue']]))
            : {}),
        }),
      };
      const other = projectEventForViewer(event, hidden, none);
      expect(JSON.stringify(other)).not.toContain('rogue');
      expect(JSON.stringify(other)).not.toContain('"x":7');
      expect(projectEventForViewer(event, hidden, owner)).toEqual(event);
    });
  }

  it('projects CombatStarted.order per viewer without mutating the source event', () => {
    const full = {
      type: 'CombatStarted',
      order: ['pc', 'rogue'],
      combatants: [
        { id: 'pc', pos: { x: 1, y: 1 } },
        { id: 'rogue', pos: { x: 7, y: 9 } },
      ],
    };
    const ordinarySeat = projectEventForViewer(full, hidden, none)!;
    const hostWithoutControl = projectEventForViewer(full, hidden, none)!;
    const controller = projectEventForViewer(full, hidden, owner)!;
    expect(ordinarySeat.order).toEqual(['pc']);
    expect(hostWithoutControl.order).toEqual(['pc']);
    expect(controller).toEqual(full);
    expect(full.order).toEqual(['pc', 'rogue']);
  });

  it('redacts list entries but keeps visible ones', () => {
    const out = projectEventForViewer(
      { type: 'AreaResolved', cells: [], affected: ['pc', 'rogue'] },
      hidden,
      none,
    );
    expect(out).toEqual({ type: 'AreaResolved', cells: [], affected: ['pc'] });
  });

  it('fails closed for an undeclared event type', () => {
    const event = { type: 'BrandNewEvent', entityId: 'pc' };
    expect(projectEventForViewer(event, hidden, none)).toBeNull();
    expect(projectEventForViewer(event, hidden, owner)).toBeNull();
  });

  it('declares every combat event type the engine and room can emit', () => {
    const root = resolve(__dirname, '../../../..');
    const files = [
      'packages/engine/src/combat/state.ts',
      'packages/engine/src/combat/attack.ts',
      'packages/engine/src/combat/conditions.ts',
      'packages/engine/src/combat/spells.ts',
      'packages/engine/src/map/movement.ts',
      'apps/server/src/room/combat.ts',
      'apps/server/src/room/combatBootstrap.ts',
      'apps/server/src/room/combatEngine.ts',
      'apps/server/src/room/death.ts',
    ];
    // Wire messages carry combat state too; each must be declared in WIRE_MESSAGE_RULES.
    const notEvents = new Set(['Error']);
    const found = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(resolve(root, file), 'utf8').matchAll(
        /type: '([A-Z][A-Za-z]+)'/g,
      ))
        if (!notEvents.has(m[1]!)) found.add(m[1]!);
    expect(
      [...found].filter(
        (t) => !(t in EVENT_ID_RULES) && !(t in WIRE_MESSAGE_RULES),
      ),
    ).toEqual([]);
  });

  it('reaction prompts: hidden reactor or hidden mover only reaches who may know', () => {
    const p = { entityId: 'rogue', moverId: 'pc' };
    expect(reactionPromptVisibleTo(p, hidden, none)).toBe(false);
    expect(reactionPromptVisibleTo(p, hidden, owner)).toBe(true);
    const q = { entityId: 'pc', moverId: 'rogue' };
    expect(reactionPromptVisibleTo(q, hidden, none)).toBe(false);
    expect(reactionPromptVisibleTo(q, hidden, new Set(['pc']))).toBe(true);
    expect(
      reactionPromptVisibleTo({ entityId: 'pc', moverId: 'x' }, hidden, none),
    ).toBe(true);
  });
});
