import type { Connection, Room } from '../../src/room/Room.js';

export async function joinSeated(
  room: Room,
  accountId: string,
  connection: Connection,
  displayName = accountId,
  matureOptOut = false,
  lastSeq = -1,
  options: { requireExistingSeat?: boolean } = {},
): Promise<void> {
  await room.seat(accountId, displayName, matureOptOut);
  await room.join(
    accountId,
    connection,
    displayName,
    matureOptOut,
    lastSeq,
    options,
  );
}
