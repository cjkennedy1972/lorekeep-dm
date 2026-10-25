import { describe, expect, it } from 'vitest';
import { rleEncode, type Battlemap } from '@game/schema';
import { lateJoinSpawnCell } from '../src/room/lateJoinSpawn.js';

const map = (cells: Array<{ x: number; y: number }>): Battlemap => ({
  mapId: 'scene-map',
  w: 4,
  h: 3,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: rleEncode(Array(12).fill(0)),
  edges: [],
  features: [],
  markers: [{ markerId: 'party-entry', cell: { x: 0, y: 1 }, label: 'Entry' }],
  zones: [{ zoneId: 'player-entry', kind: 'spawn', cells }],
  diagonalRule: '5ft',
});

describe('lateJoinSpawnCell', () => {
  it('chooses the nearest reachable free authored player-entry cell with row/column tie-breaks', () => {
    expect(
      lateJoinSpawnCell(
        map([
          { x: 2, y: 1 },
          { x: 1, y: 2 },
          { x: 1, y: 0 },
        ]),
        [{ id: 'party-1', team: 'party', size: 1, pos: { x: 1, y: 1 } }],
      ),
    ).toEqual({ x: 1, y: 0 });
  });

  it('uses a reachable nearest open cell from the designated entry marker when no player zone exists', () => {
    const withoutZone = { ...map([]), zones: [] };
    expect(lateJoinSpawnCell(withoutZone, [])).toEqual({ x: 0, y: 1 });
  });

  it('stays pending if all authored player-entry cells are blocked or occupied', () => {
    expect(
      lateJoinSpawnCell(map([{ x: 0, y: 1 }]), [
        { id: 'party-1', team: 'party', size: 1, pos: { x: 0, y: 1 } },
      ]),
    ).toBeNull();
  });
});
