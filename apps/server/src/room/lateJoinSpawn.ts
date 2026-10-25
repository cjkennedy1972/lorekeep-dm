import { rleDecode, type Battlemap, type GridPos } from '@game/schema';
import { movementNeighbors, type MovementEntity } from '@game/rules-engine';

/** Return a deterministic legal player-entry cell; null means the join must remain pending. */
export function lateJoinSpawnCell(
  map: Battlemap,
  occupied: readonly MovementEntity[],
  size = 1,
): GridPos | null {
  const terrain = rleDecode(map.cells);
  const spawnZone =
    map.zones.find(
      (zone) =>
        zone.kind === 'spawn' && /party|pc|player|hero/.test(zone.zoneId),
    ) ?? null;
  const anchorMarkerId =
    spawnZone?.anchorMarkerId ??
    map.zones.find(
      (zone) => zone.kind === 'spawn' && !/foe|enemy|monster/.test(zone.zoneId),
    )?.anchorMarkerId;
  const anchor =
    map.markers.find((marker) => marker.markerId === anchorMarkerId)?.cell ??
    map.markers.find((marker) =>
      /party.?entry|player.?entry|entry.?anchor/i.test(marker.markerId),
    )?.cell;
  const validCell = (cell: GridPos) => {
    if (
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x + size > map.w ||
      cell.y + size > map.h
    )
      return false;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const tile = terrain[(cell.y + dy) * map.w + cell.x + dx] ?? 0;
        if (map.palette[tile]?.blocksMove) return false;
      }
    return !occupied.some(
      (entity) =>
        cell.x < entity.pos.x + entity.size &&
        cell.x + size > entity.pos.x &&
        cell.y < entity.pos.y + entity.size &&
        cell.y + size > entity.pos.y,
    );
  };
  const candidates: GridPos[] = spawnZone
    ? [...spawnZone.cells]
    : anchor
      ? Array.from({ length: map.w * map.h }, (_, index) => ({
          x: index % map.w,
          y: Math.floor(index / map.w),
        }))
      : [];
  const start = anchor ?? spawnZone?.cells[0];
  const reachable = new Set<string>();
  if (start) {
    const mover: MovementEntity = {
      id: '__late_join_anchor__',
      team: 'party',
      pos: start,
      size,
    };
    const state = { map, entities: [...occupied, mover] };
    const queue = [start];
    reachable.add(`${start.x},${start.y}`);
    while (queue.length) {
      const from = queue.shift()!;
      for (const cell of movementNeighbors(state, mover, from)) {
        const key = `${cell.x},${cell.y}`;
        if (reachable.has(key)) continue;
        reachable.add(key);
        queue.push(cell);
      }
    }
  }
  return (
    candidates
      .filter(validCell)
      .filter((cell) => !start || reachable.has(`${cell.x},${cell.y}`))
      .sort((a, b) => {
        const distance = (cell: GridPos) =>
          start ? Math.abs(cell.x - start.x) + Math.abs(cell.y - start.y) : 0;
        return distance(a) - distance(b) || a.y - b.y || a.x - b.x;
      })[0] ?? null
  );
}
