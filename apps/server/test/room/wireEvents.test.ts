import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '@game/schema';
import { toWireEvent } from '../../src/room/combat.js';

describe('toWireEvent', () => {
  it('spells SlotSpent the way the wire schema does, so clients can parse it', () => {
    const engine = { type: 'SlotSpent', entityId: 'ent_a', slotLevel: 1 };
    expect(EngineEventSchema.safeParse(engine).success).toBe(false);
    const wire = toWireEvent(engine);
    expect(EngineEventSchema.safeParse(wire).success).toBe(true);
    expect(wire).toMatchObject({ level: 1 });
  });
  it('spells a concentration save so clients receive its DC and outcome', () => {
    const engine = {
      type: 'RollEvent',
      entityId: 'ent_goblin',
      spellId: 'srd:spell/bless',
      kind: 'save',
      breakdown: {
        expression: '1d20',
        dice: [{ sides: 20, value: 7, kept: true }],
        modifiers: [{ label: 'constitution', value: 2 }],
        total: 9,
      },
      dc: 10,
      success: false,
    };
    const wire = toWireEvent(engine);
    expect(EngineEventSchema.safeParse(wire).success).toBe(true);
    expect(wire).toMatchObject({
      type: 'RollEvent',
      actorId: 'ent_goblin',
      dice: '1d20',
      rolls: [7],
      modifier: 2,
      total: 9,
      dc: 10,
      success: false,
    });
  });
  it('spells an attack roll so clients can parse it', () => {
    const engine = {
      type: 'RollEvent',
      entityId: 'ent_hero',
      attackId: 'sword',
      kind: 'attack',
      breakdown: {
        expression: '1d20',
        dice: [{ sides: 20, value: 15, kept: true }],
        modifiers: [{ label: 'attack', value: 4 }],
        total: 19,
      },
    };
    expect(EngineEventSchema.safeParse(toWireEvent(engine)).success).toBe(true);
  });
  it('leaves other events untouched', () => {
    const event = { type: 'HpChanged', entityId: 'ent_a', delta: -3, hp: 7 };
    expect(toWireEvent(event)).toEqual(event);
  });
});
