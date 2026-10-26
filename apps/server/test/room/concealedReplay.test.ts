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

  it('never records a visible entity', () => {
    const state = reduceRoom(
      emptyRoom(SID),
      commit({ combatRoom: { entities: [{ id: 'pc', name: 'Hero' }] } }, 1),
    );
    expect(concealedEntities(state.gameState)).toEqual([]);
  });
});
