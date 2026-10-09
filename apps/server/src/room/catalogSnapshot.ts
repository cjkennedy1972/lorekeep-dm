import { CatalogEntrySchema, type CatalogEntry } from '@game/schema';
import type { Catalog } from '@game/rules-engine';
import { catalogVersionOf } from '@game/rules-engine/catalog-node';

/** Rehydrate a session's immutable catalog copy and verify it against the pinned hash. */
export function catalogFromSnapshot(
  version: string | null,
  snapshot: unknown,
): Catalog | undefined {
  if (!version || !Array.isArray(snapshot)) return undefined;
  const entries: CatalogEntry[] = [];
  for (const raw of snapshot) {
    const parsed = CatalogEntrySchema.safeParse(raw);
    if (!parsed.success) return undefined;
    entries.push(parsed.data);
  }
  if (catalogVersionOf(entries) !== version) return undefined;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) return undefined;
  return {
    catalogVersion: version,
    entries,
    getAny: (id) => byId.get(id),
    get: (kind, id) => {
      const entry = byId.get(id);
      return (entry?.kind === kind ? entry : undefined) as never;
    },
  };
}
