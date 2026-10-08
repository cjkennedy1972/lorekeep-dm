import type { CatalogEntry } from '@game/schema';
import type { Catalog } from '@game/rules-engine';
import rawBackgrounds from '../../../../../packages/engine/catalog/backgrounds.json';
import rawClassesA from '../../../../../packages/engine/catalog/classes-a.json';
import rawClassesB from '../../../../../packages/engine/catalog/classes-b.json';
import rawEquipment from '../../../../../packages/engine/catalog/equipment.json';
import rawSpecies from '../../../../../packages/engine/catalog/species.json';
import rawSpells from '../../../../../packages/engine/catalog/spells.json';
import rawConditions from '../../../../../packages/engine/catalog/conditions.json';

/** Browser-safe catalog assembled from checked-in JSON; no node filesystem dependency. */
export function loadCharacterCatalog(): Catalog {
  const entries = [
    ...rawBackgrounds,
    ...rawClassesA,
    ...rawClassesB,
    ...rawEquipment,
    ...rawSpecies,
    ...rawSpells,
    ...rawConditions,
  ] as CatalogEntry[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    catalogVersion: 'browser-catalog-v0',
    entries,
    getAny: (id) => byId.get(id),
    get: (kind, id) => {
      const entry = byId.get(id);
      return entry?.kind === kind ? (entry as never) : undefined;
    },
  };
}
