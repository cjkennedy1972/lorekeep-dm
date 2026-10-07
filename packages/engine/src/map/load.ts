import {
  validateBattlemap,
  type MapError,
  type MapValidation,
} from './validate.js';

// ponytail: no terrain catalog exists yet; this is the authored-terrain vocabulary. Move into catalog when one lands.
export const CATALOG_TERRAIN_IDS: ReadonlySet<string> = new Set([
  'floor',
  'rubble',
  'grass',
  'mud',
  'water',
  'tree',
  'stone-wall',
  'pillar',
]);

export function loadAuthoredMap(json: unknown): MapValidation {
  const v = validateBattlemap(json);
  if (!v.ok) return v;
  const errors: MapError[] = v.map.palette
    .filter((p) => !CATALOG_TERRAIN_IDS.has(p.terrainId))
    .map((p) => ({
      code: 'UNKNOWN_ID' as const,
      message: `unknown terrain id ${p.terrainId}`,
    }));
  return errors.length ? { ok: false, errors } : v;
}
