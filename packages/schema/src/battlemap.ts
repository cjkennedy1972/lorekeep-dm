import { z } from 'zod';

export const MAX_MAP_DIM = 60;
export const MAX_MAP_CELLS = MAX_MAP_DIM * MAX_MAP_DIM;
// one [index, run] pair per cell is the worst case
const MAX_RLE_LEN = MAX_MAP_CELLS * 2;

export const CoverSchema = z.enum(['none', 'half', 'three-quarters', 'full']);
export type Cover = z.infer<typeof CoverSchema>;

export const PaletteEntrySchema = z.object({
  terrainId: z.string().min(1),
  moveCost: z.int().min(1).max(4),
  blocksMove: z.boolean(),
  blocksSight: z.boolean(),
  cover: CoverSchema,
  elevation: z.int(),
});
export type PaletteEntry = z.infer<typeof PaletteEntrySchema>;

export const CellSchema = z.object({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
});
export type Cell = z.infer<typeof CellSchema>;

// An edge lies between two orthogonally adjacent cells a and b.
export const EdgeSchema = z.object({
  a: CellSchema,
  b: CellSchema,
  kind: z.enum(['wall', 'door', 'window']),
  state: z.enum(['open', 'closed', 'locked']).optional(), // doors only
});
export type Edge = z.infer<typeof EdgeSchema>;

export const FeatureSchema = z.object({
  featureId: z.string().min(1),
  kind: z.string().min(1),
  cells: z.array(CellSchema).min(1),
  tags: z.array(z.string()),
});

export const MarkerSchema = z.object({
  markerId: z.string().min(1),
  cell: CellSchema,
  label: z.string(),
});

export const ZoneSchema = z.object({
  zoneId: z.string().min(1),
  kind: z.enum(['spawn', 'light']),
  cells: z.array(CellSchema).min(1),
  light: z.enum(['bright', 'dim', 'dark']).optional(),
  anchorMarkerId: z.string().optional(),
});

export const BattlemapSchema = z.object({
  mapId: z.string().min(1),
  w: z.int().min(1).max(MAX_MAP_DIM),
  h: z.int().min(1).max(MAX_MAP_DIM),
  palette: z.array(PaletteEntrySchema).min(1),
  // flat [paletteIndex, runLength, ...] pairs, row-major
  cells: z.array(z.int().nonnegative()).max(MAX_RLE_LEN),
  edges: z.array(EdgeSchema),
  features: z.array(FeatureSchema),
  markers: z.array(MarkerSchema),
  zones: z.array(ZoneSchema),
  diagonalRule: z.enum(['5ft', 'alternate']).default('5ft'),
});
export type Battlemap = z.infer<typeof BattlemapSchema>;

export function rleEncode(grid: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.length; ) {
    let j = i + 1;
    while (j < grid.length && grid[j] === grid[i]) j++;
    out.push(grid[i]!, j - i);
    i = j;
  }
  return out;
}

export type RleErrorCode = 'RLE_ODD_LENGTH' | 'RLE_BAD_RUN' | 'RLE_TOO_LARGE';

export class RleError extends Error {
  constructor(
    readonly code: RleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RleError';
  }
}

export function rleDecode(rle: readonly number[]): number[] {
  if (rle.length % 2 !== 0)
    throw new RleError('RLE_ODD_LENGTH', 'rle has a trailing element');
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const run = rle[i + 1]!;
    if (!Number.isInteger(run) || run < 1)
      throw new RleError('RLE_BAD_RUN', `invalid run length ${run}`);
    total += run;
    if (total > MAX_MAP_CELLS)
      throw new RleError('RLE_TOO_LARGE', `rle exceeds ${MAX_MAP_CELLS} cells`);
    for (let n = 0; n < run; n++) out.push(rle[i]!);
  }
  return out;
}
