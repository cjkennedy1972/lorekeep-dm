const PREFIX = 'ent_seat_';

/** ADR-035: a party seat's engine entity id is derived from the stable seat id, never from the client. */
export const seatEntityId = (seatId: string): string => `${PREFIX}${seatId}`;

/** Inverse of `seatEntityId`; undefined for any other entity id (monsters, solo actors). */
export const seatIdFromEntityId = (entityId: string): string | undefined =>
  entityId.startsWith(PREFIX) ? entityId.slice(PREFIX.length) : undefined;
