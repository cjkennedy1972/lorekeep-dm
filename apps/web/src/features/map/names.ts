/** Display names for combat entities, built only from state the client already holds. */

type SeatLike = { seatId: string; accountId: string; displayName: string };
type CharacterLike = { id?: string; name?: string };
type EntityLike = { id: string; name?: string; kind?: string };

const SEAT_PREFIX = 'ent_seat_';
const titleCase = (word: string) =>
  word ? word[0]!.toUpperCase() + word.slice(1) : word;

/**
 * "ent_goblin-minion_1" becomes "Goblin Minion". The trailing id number is dropped, so a lone entity
 * never shows it and twins are numbered by the namer in visible order instead.
 */
export function nameFromCatalogId(id: string): string {
  const stem = id
    .replace(/^ent_/, '')
    .replace(/[_-]?\d+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const words = stem.split(/\s+/).filter(Boolean).map(titleCase).join(' ');
  return words || 'Creature';
}

/** Two letters at most; a trailing number keeps twins apart ("Goblin Minion 2" is "G2"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const last = words.at(-1)!;
  if (words.length > 1 && /^\d+$/.test(last)) {
    // A single-digit suffix keeps twins apart ("G2"); longer numbers are just part of a name.
    if (last.length === 1) return `${words[0]![0]!.toUpperCase()}${last}`;
    return initialsOf(words.slice(0, -1).join(' '));
  }
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/**
 * Builds a lookup from entity id to a human name. Order of preference: a name on the entity itself,
 * the character bound to that seat, the seat's display name, then a label derived from the catalog id.
 * Seats with no known name become "Party member N" in the order they appear on the map.
 */
export function createEntityNamer(input: {
  entities: readonly EntityLike[];
  seats?: readonly SeatLike[];
  characters?: Readonly<Record<string, CharacterLike | undefined>>;
}): (entityId: string) => string {
  const { entities, seats = [], characters = {} } = input;
  const byCharacterId = new Map<string, string>();
  for (const character of Object.values(characters))
    if (character?.id && character.name)
      byCharacterId.set(character.id, character.name);
  const names = new Map<string, string>();
  let partyIndex = 0;
  for (const entity of entities) {
    if (entity.name) {
      names.set(entity.id, entity.name);
      continue;
    }
    if (entity.id.startsWith(SEAT_PREFIX)) {
      partyIndex += 1;
      const seat = seats.find(
        (item) => item.seatId === entity.id.slice(SEAT_PREFIX.length),
      );
      names.set(
        entity.id,
        (seat && characters[seat.accountId]?.name) ||
          seat?.displayName ||
          `Party member ${partyIndex}`,
      );
      continue;
    }
    const bound = byCharacterId.get(entity.id);
    if (bound) {
      names.set(entity.id, bound);
      continue;
    }
    if (entity.kind === 'character') {
      partyIndex += 1;
      names.set(entity.id, `Party member ${partyIndex}`);
      continue;
    }
    names.set(entity.id, nameFromCatalogId(entity.id));
  }
  // Twins ("Goblin Minion" x2) get numbers so the tracker, tokens and legend stay unambiguous.
  // Names are grouped before any numbering, and numbers count only the entities this viewer was sent,
  // in map order, so 1..n has no gaps and never encodes an id, which could reveal a hidden sibling.
  const tally = new Map<string, string[]>();
  for (const [id, name] of names)
    tally.set(name, [...(tally.get(name) ?? []), id]);
  for (const [name, ids] of tally) {
    if (ids.length < 2) continue;
    ids.forEach((id, index) => {
      names.set(id, `${name} ${index + 1}`);
    });
  }
  return (entityId) =>
    names.get(entityId) ??
    (entityId.startsWith(SEAT_PREFIX)
      ? (seats.find((item) => item.seatId === entityId.slice(9))?.displayName ??
        'Party member')
      : nameFromCatalogId(entityId));
}
