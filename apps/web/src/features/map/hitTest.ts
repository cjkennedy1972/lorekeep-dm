import type { MapViewport } from './viewport.js';

export interface MapCell {
  readonly x: number;
  readonly y: number;
}

/** Converts a screen-space point into a map cell; points outside the map return null. */
export function hitTestCell(
  screenX: number,
  screenY: number,
  viewport: MapViewport,
  cellSize: number,
  width: number,
  height: number,
): MapCell | null {
  if (
    ![screenX, screenY, cellSize, width, height].every(Number.isFinite) ||
    cellSize <= 0 ||
    viewport.zoom <= 0
  )
    return null;
  const x = Math.floor((screenX - viewport.x) / (cellSize * viewport.zoom));
  const y = Math.floor((screenY - viewport.y) / (cellSize * viewport.zoom));
  return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null;
}
