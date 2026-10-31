import { describe, expect, it } from 'vitest';
import { emptyRoom, reduceRoom } from '../../src/room/reducer.js';
import { concealedEntities } from '../../src/room/eventVisibility.js';

const SID = '11111111-1111-4111-8111-111111111111';
const commit = (gameState: unknown, seq: number) =>
  ({
    type: 'GameStateCommitted',
    payload: { gameState },
    seq,
  }) as never;

describe('concealed identities', () => {
  it('state rebuilt from events keeps the record after the hidden entity is gone', () => {
    const events = [
      commit(
        {
          combatRoom: {
            entities: [{ id: 'g', name: 'Gribble', hidden: true }],
          },
        },
        1,
      ),
      commit({ combatRoom: { entities: [{ id: 'pc', name: 'Hero' }] } }, 2),
      commit({ sceneId: 'later' }, 3),
    ];
    const rebuilt = events.reduce(reduceRoom, emptyRoom(SID));
    expect(concealedEntities(rebuilt.gameState)).toEqual([
      { id: 'g', name: 'Gribble' },
    ]);
  });

  it('replays the revealed snapshot and can rewind to the earlier hidden snapshot', () => {
    const hidden = {
      combatRoom: { entities: [{ id: 'g', name: 'Gribble', hidden: true }] },
    };
    const revealed = {
      combatRoom: { entities: [{ id: 'g', name: 'Gribble', hidden: false }] },
    };
    const history = [
      commit(hidden, 1),
      {
        type: 'EntityRevealed',
        payload: { entityId: 'g', cause: 'bump' },
        seq: 2,
      } as never,
      commit(revealed, 3),
    ];
    const restarted = history.reduce(reduceRoom, emptyRoom(SID));
    expect(
      (restarted.gameState as typeof revealed).combatRoom.entities[0]?.hidden,
    ).toBe(false);
    const rewound = history.slice(0, 1).reduce(reduceRoom, emptyRoom(SID));
    expect(
      (rewound.gameState as typeof hidden).combatRoom.entities[0]?.hidden,
    ).toBe(true);
  });

  it('never records a visible entity', () => {
    const state = reduceRoom(
      emptyRoom(SID),
      commit({ combatRoom: { entities: [{ id: 'pc', name: 'Hero' }] } }, 1),
    );
    expect(concealedEntities(state.gameState)).toEqual([]);
  });
});
