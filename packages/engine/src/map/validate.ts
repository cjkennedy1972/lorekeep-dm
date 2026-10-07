import {
  BattlemapSchema,
  rleDecode,
  type Battlemap,
  type Cell,
} from '@game/schema';

export type MapErrorCode =
  | 'SCHEMA_INVALID'
  | 'DIMENSION_MISMATCH'
  | 'BAD_PALETTE_INDEX'
  | 'UNKNOWN_ID'
  | 'DUPLICATE_ID'
  | 'CELL_OUT_OF_BOUNDS'
  | 'EDGE_OUT_OF_BOUNDS'
  | 'DOOR_NOT_ON_EDGE'
  | 'DOOR_STATE_INVALID';

export interface MapError {
  code: MapErrorCode;
  message: string;
}

export type MapValidation =
  | { ok: true; map: Battlemap }
  | { ok: false; errors: MapError[] };

export function validateBattlemap(input: unknown): MapValidation {
  const parsed = BattlemapSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'SCHEMA_INVALID' as const,
        message: `${i.path.join('.')}: ${i.message}`,
      })),
    };
  }
  const map = parsed.data;
  const errors: MapError[] = [];
  const err = (code: MapErrorCode, message: string) =>
    errors.push({ code, message });
  const inBounds = (c: Cell) => c.x < map.w && c.y < map.h;

  const rle = map.cells;
  let total = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    total += rle[i + 1]!;
    if (rle[i]! >= map.palette.length)
      err('BAD_PALETTE_INDEX', `palette index ${rle[i]} out of range`);
  }
  if (rle.length % 2 !== 0 || total !== map.w * map.h) {
    err(
      'DIMENSION_MISMATCH',
      `cells decode to ${rleDecode(rle).length}, expected ${map.w * map.h}`,
    );
  }

  for (const [list, name] of [
    [map.features.map((f) => f.featureId), 'feature'],
    [map.markers.map((m) => m.markerId), 'marker'],
    [map.zones.map((z) => z.zoneId), 'zone'],
    [map.palette.map((p) => p.terrainId), 'terrain'],
  ] as const) {
    if (new Set(list).size !== list.length)
      err('DUPLICATE_ID', `duplicate ${name} id`);
  }

  for (const f of map.features) {
    if (!f.cells.every(inBounds))
      err('CELL_OUT_OF_BOUNDS', `feature ${f.featureId} outside map`);
  }
  for (const m of map.markers) {
    if (!inBounds(m.cell))
      err('CELL_OUT_OF_BOUNDS', `marker ${m.markerId} outside map`);
  }
  const markerIds = new Set(map.markers.map((m) => m.markerId));
  for (const z of map.zones) {
    if (!z.cells.every(inBounds))
      err('CELL_OUT_OF_BOUNDS', `zone ${z.zoneId} outside map`);
    if (z.anchorMarkerId !== undefined && !markerIds.has(z.anchorMarkerId)) {
      err(
        'UNKNOWN_ID',
        `zone ${z.zoneId} references unknown marker ${z.anchorMarkerId}`,
      );
    }
  }
  for (const e of map.edges) {
    if (!inBounds(e.a) || !inBounds(e.b)) {
      err(
        'EDGE_OUT_OF_BOUNDS',
        `edge (${e.a.x},${e.a.y})-(${e.b.x},${e.b.y}) outside map`,
      );
      continue;
    }
    if (Math.abs(e.a.x - e.b.x) + Math.abs(e.a.y - e.b.y) !== 1) {
      err(
        'DOOR_NOT_ON_EDGE',
        `${e.kind} cells (${e.a.x},${e.a.y}) and (${e.b.x},${e.b.y}) are not adjacent`,
      );
    }
    if ((e.kind === 'door') !== (e.state !== undefined)) {
      err(
        'DOOR_STATE_INVALID',
        `${e.kind} edge has invalid state ${e.state ?? 'none'}`,
      );
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, map };
}
