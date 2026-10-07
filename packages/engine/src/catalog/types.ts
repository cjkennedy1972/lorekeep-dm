import type { CatalogEntry, CatalogKind } from '@game/schema';
export interface Catalog {
  catalogVersion: string;
  entries: readonly CatalogEntry[];
  get<K extends CatalogKind>(
    kind: K,
    id: string,
  ): Extract<CatalogEntry, { kind: K }> | undefined;
  getAny(id: string): CatalogEntry | undefined;
}
