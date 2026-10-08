/** Serializable camera state. Coordinates are in screen pixels; zoom scales cellSize. */
export interface MapViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const DEFAULT_VIEWPORT: MapViewport = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function zoomViewport(viewport: MapViewport, factor: number): MapViewport {
  return { ...viewport, zoom: clampZoom(viewport.zoom * factor) };
}

export function panViewport(viewport: MapViewport, dx: number, dy: number): MapViewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/** Wheel uses exponential scaling for consistent fine control at any zoom. */
export function wheelZoom(viewport: MapViewport, deltaY: number): MapViewport {
  return zoomViewport(viewport, Math.exp(-deltaY * 0.001));
}

/** Pointer drag and keyboard arrows share this exact pan operation. */
export function keyboardPan(viewport: MapViewport, key: string, step = 32): MapViewport {
  switch (key) {
    case 'ArrowLeft': return panViewport(viewport, step, 0);
    case 'ArrowRight': return panViewport(viewport, -step, 0);
    case 'ArrowUp': return panViewport(viewport, 0, step);
    case 'ArrowDown': return panViewport(viewport, 0, -step);
    case '+':
    case '=': return zoomViewport(viewport, 1.2);
    case '-': return zoomViewport(viewport, 1 / 1.2);
    default: return viewport;
  }
}
