import { describe, expect, it } from 'vitest';
import { hitTestCell } from '../src/features/map/hitTest.js';
import { keyboardPan, panViewport, clampZoom, zoomViewport, type MapViewport } from '../src/features/map/viewport.js';
import { createGameStore } from '../src/state/gameStore.js';

const camera: MapViewport = { x: 10, y: 20, zoom: 1 };

describe('map viewport and hit testing', () => {
  it.each([0.5, 1, 2])('hit-tests screen coordinates at zoom %s', (zoom) => {
    const viewport = { ...camera, zoom };
    expect(hitTestCell(10 + 2 * 32 * zoom + 1, 20 + 3 * 32 * zoom + 1, viewport, 32, 10, 10)).toEqual({ x: 2, y: 3 });
  });

  it('clamps zoom to the documented bounds', () => {
    expect(clampZoom(99)).toBe(3);
    expect(clampZoom(0.01)).toBe(0.5);
    expect(zoomViewport(camera, 100).zoom).toBe(3);
  });

  it('provides keyboard equivalents for pointer pan', () => {
    expect(keyboardPan(camera, 'ArrowLeft')).toEqual(panViewport(camera, 32, 0));
    expect(keyboardPan(camera, 'ArrowRight')).toEqual(panViewport(camera, -32, 0));
    expect(keyboardPan(camera, 'ArrowUp')).toEqual(panViewport(camera, 0, 32));
    expect(keyboardPan(camera, 'ArrowDown')).toEqual(panViewport(camera, 0, -32));
  });

  it('preserves selected cell across zoom and pan state updates', () => {
    const store = createGameStore();
    store.setSelectedCell({ x: 4, y: 7 });
    store.setViewport(zoomViewport(store.getState().viewport, 2));
    store.setViewport(panViewport(store.getState().viewport, 50, -20));
    expect(store.getState().selectedCell).toEqual({ x: 4, y: 7 });
  });
});
