import { describe, expect, it } from 'vitest';
import { Canvas2DRenderer } from '../src/features/map/Canvas2DRenderer.js';
import { createTokenDrawCommands } from '../src/features/map/tokens.js';
import { rleEncode, type Battlemap, type CombatState } from '@game/schema';

/** Records arc calls so the test can count rings per token without a real canvas. */
function recordingContext() {
  const arcs: number[] = [];
  const texts: string[] = [];
  const context = {
    arc: (_x: number, _y: number, r: number) => arcs.push(r),
    fillText: (text: string) => texts.push(text),
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    setLineDash: () => undefined,
  };
  return {
    context: context as unknown as CanvasRenderingContext2D,
    arcs,
    texts,
  };
}

const map: Battlemap = {
  mapId: 'm',
  name: 'm',
  w: 2,
  h: 2,
  palette: [{ terrainId: 'floor', moveCost: 1, blocksMove: false }],
  cells: rleEncode([0, 0, 0, 0]),
  edges: [],
  features: [],
  markers: [],
} as unknown as Battlemap;

const combat = {
  initiative: [
    { entityId: 'pc-1', initiative: 18 },
    { entityId: 'orc-1', initiative: 10 },
  ],
  entities: [
    { id: 'pc-1', kind: 'character', pos: { x: 0, y: 0 }, size: 1, hp: 12 },
    { id: 'orc-1', kind: 'monster', pos: { x: 1, y: 0 }, size: 1, hp: 4 },
  ],
} as unknown as CombatState;

describe('token drawing', () => {
  it('draws one token per tracker entry and marks only the first as active', () => {
    const tokens = createTokenDrawCommands(
      { ...combat, activeEntityId: 'pc-1' },
      {
        'pc-1': { name: 'Mira' },
        'orc-1': { name: 'Orc' },
      },
    );
    const { context, arcs, texts } = recordingContext();
    new Canvas2DRenderer().draw(context, map, { cellSize: 32 }, tokens);

    expect(
      tokens.filter((token) => token.active).map((token) => token.entityId),
    ).toEqual(['pc-1']);
    // Only the active PC (team index 0 → circle) draws arcs: body r=11.52 plus rings at +5 and +9.
    const tokenArcs = arcs.filter((radius) => radius > 10);
    expect(tokenArcs).toEqual([16.52, 20.52, 11.52]);
    // Tokens carry the combatant's initials; the team is the shape.
    expect(texts).toContain('M');
    expect(texts).toContain('O');
  });

  it('keeps the map draw unchanged when no tokens are passed', () => {
    const { context, arcs } = recordingContext();
    const commands = new Canvas2DRenderer().draw(context, map, {
      cellSize: 32,
    });
    expect(commands.map((command) => command.type)).not.toContain('token');
    expect(arcs.filter((radius) => radius > 10)).toHaveLength(0);
  });
});
