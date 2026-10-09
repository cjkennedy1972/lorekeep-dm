import { describe, expect, it } from 'vitest';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { catalogVersionOf } from '@game/rules-engine/catalog-node';
import { catalogFromSnapshot } from '../../src/room/catalogSnapshot.js';

describe('pinned catalog snapshots', () => {
  it('rehydrates an older content version after the current catalog has changed', () => {
    const current = loadCatalog();
    const historicalEntries = current.entries.map((entry, index) =>
      index === 0 && 'name' in entry
        ? { ...entry, name: `${entry.name} (historical)` }
        : entry,
    );
    const historicalVersion = catalogVersionOf(historicalEntries);

    expect(historicalVersion).not.toBe(current.catalogVersion);
    const restored = catalogFromSnapshot(historicalVersion, historicalEntries);

    expect(restored?.catalogVersion).toBe(historicalVersion);
    expect(restored?.entries).toEqual(historicalEntries);
    expect(restored?.getAny(historicalEntries[0]!.id)).toEqual(
      historicalEntries[0],
    );
  });

  it('rejects missing, malformed, or hash-mismatched snapshots', () => {
    const current = loadCatalog();
    expect(catalogFromSnapshot(current.catalogVersion, null)).toBeUndefined();
    expect(catalogFromSnapshot(current.catalogVersion, [{}])).toBeUndefined();
    expect(
      catalogFromSnapshot('0'.repeat(64), current.entries),
    ).toBeUndefined();
  });
});
