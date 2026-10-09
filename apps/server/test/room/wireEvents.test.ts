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
  it('leaves other events untouched', () => {
    const event = { type: 'HpChanged', entityId: 'ent_a', delta: -3, hp: 7 };
    expect(toWireEvent(event)).toEqual(event);
  });
});
