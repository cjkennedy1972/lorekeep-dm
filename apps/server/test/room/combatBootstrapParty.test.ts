import { describe, expect, it } from 'vitest';
import { rleEncode } from '@game/schema';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { reconcileCombat } from '../../src/room/combatBootstrap.js';
import { seatEntityId } from '../../src/room/seatEntity.js';

describe('party combat bootstrap (ADR-035)', () => {
  it('re-keys PC entities and initiative to the seat entity id and never exposes the character id', () => {
    const seatId = '00000000-0000-4000-8000-000000000001';
    const character = {
      ...quickBuild(loadCatalog(), undefined, 0x28, 1).character,
      id: 'char-source-id',
    };
    const game = {
      gameEngine: {
        map: {
          w: 2,
          h: 1,
          cells: rleEncode([0, 0]),
          palette: [{ blocksMove: false }],
          zones: [],
        },
        entities: [
          {
            id: 'char-source-id',
            team: 'party',
            pos: { x: 0, y: 0 },
            size: 1,
            hp: 8,
            maxHp: 8,
            ac: 12,
            speed: 30,
          },
        ],
        combat: { initiative: [{ entityId: 'char-source-id', total: 15 }] },
      },
    };
    const catalog = { get: () => undefined } as never;
    const result = reconcileCombat(
      game as never,
      catalog,
      Date.now(),
      new Map([[seatId, { characterSnapshot: character }]]),
    );
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result!.events);
    expect(serialized).toContain(seatEntityId(seatId));
    expect(serialized).not.toContain('char-source-id');
    expect(result!.gameState.combatActors).toEqual({});
  });
});
