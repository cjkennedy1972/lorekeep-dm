import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { BattlemapSchema } from '@game/schema';
import { loadAuthoredMap } from '@game/rules-engine';
import { Canvas2DRenderer } from '../features/map/Canvas2DRenderer.js';

const files = import.meta.glob('../../../../packages/engine/maps/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const CELL = 16;

/** Dev-only viewer: draws one authored map from packages/engine/maps (used by the map smoke test). */
export function SandboxMap() {
  const { mapId = '' } = useParams();
  const canvas = useRef<HTMLCanvasElement>(null);
  const raw = Object.entries(files).find(([f]) =>
    f.endsWith(`/${mapId}.json`),
  )?.[1];
  const loaded = raw ? loadAuthoredMap(BattlemapSchema.parse(raw)) : undefined;
  const map = loaded?.ok ? loaded.map : undefined;
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (map && ctx) new Canvas2DRenderer().draw(ctx, map, { cellSize: CELL });
  }, [map]);
  if (!map) return <p role="alert">Unknown or invalid map {mapId}</p>;
  return (
    <main>
      <h1>Map {map.mapId}</h1>
      <canvas
        ref={canvas}
        id="map-canvas"
        width={map.w * CELL}
        height={map.h * CELL}
        aria-label={`${map.mapId} map`}
        role="img"
      />
    </main>
  );
}
