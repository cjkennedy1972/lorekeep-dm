import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CatalogEntrySchema,
  type CatalogEntry,
  type CatalogKind,
} from '@game/schema';
import { catalogVersionOf } from './hash.js';

export const DEFAULT_CATALOG_DIR = fileURLToPath(
  new URL('../../catalog', import.meta.url),
);

// Scope gate (spec section 8, ADR-008): spells <= L3, monsters CR <= 5.
// ponytail: class entries carry no level data yet, so the L1-5 class gate has nothing to check.
export const MAX_SPELL_LEVEL = 3;
export const MAX_MONSTER_CR = 5;

export class CatalogError extends Error {}

function scopeViolation(e: CatalogEntry): string | undefined {
  if (e.kind === 'spell' && e.level > MAX_SPELL_LEVEL)
    return `spell level ${e.level} is out of scope (max ${MAX_SPELL_LEVEL})`;
  if (e.kind === 'monster' && e.cr > MAX_MONSTER_CR)
    return `monster CR ${e.cr} is out of scope (max ${MAX_MONSTER_CR})`;
  return undefined;
}

export interface Catalog {
  catalogVersion: string;
  entries: readonly CatalogEntry[];
  get<K extends CatalogKind>(
    kind: K,
    id: string,
  ): Extract<CatalogEntry, { kind: K }> | undefined;
  /** Any kind; undefined when not loaded (including out-of-scope ids). */
  getAny(id: string): CatalogEntry | undefined;
}

/** Load every *.json file (each an array of entries) in `dir`. Throws CatalogError on any problem. */
export function loadCatalog(dir: string = DEFAULT_CATALOG_DIR): Catalog {
  const byId = new Map<string, { entry: CatalogEntry; file: string }>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      throw new CatalogError(
        `${file}: invalid JSON: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(raw))
      throw new CatalogError(`${file}: expected a JSON array of entries`);
    raw.forEach((item: unknown, i) => {
      const parsed = CatalogEntrySchema.safeParse(item);
      if (!parsed.success) {
        const id = (item as { id?: unknown } | null)?.id;
        const label = typeof id === 'string' ? id : `#${i}`;
        const issues = parsed.error.issues
          .map((x) => `${x.path.join('.') || '(entry)'}: ${x.message}`)
          .join('; ');
        throw new CatalogError(`${file}: ${label}: ${issues}`);
      }
      const entry = parsed.data;
      const bad = scopeViolation(entry);
      if (bad) throw new CatalogError(`${file}: ${entry.id}: ${bad}`);
      const prior = byId.get(entry.id);
      if (prior)
        throw new CatalogError(
          `${file}: ${entry.id}: duplicate id (also in ${prior.file})`,
        );
      byId.set(entry.id, { entry, file });
    });
  }
  const entries = [...byId.values()].map((v) => v.entry);
  return {
    catalogVersion: catalogVersionOf(entries),
    entries,
    getAny: (id) => byId.get(id)?.entry,
    get: (kind, id) => {
      const e = byId.get(id)?.entry;
      return (e?.kind === kind ? e : undefined) as never;
    },
  };
}
