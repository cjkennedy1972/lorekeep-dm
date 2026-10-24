import type { Connection, Room } from '../../src/room/Room.js';

export async function joinSeated(
  room: Room,
  accountId: string,
  connection: Connection,
  displayName = accountId,
  matureOptOut = false,
  lastSeq = -1,
  options: { requireExistingSeat?: boolean } = {},
  authTokenHash?: string,
): Promise<void> {
  await room.seat(accountId, displayName, matureOptOut, authTokenHash);
  await room.join(
    accountId,
    connection,
    displayName,
    matureOptOut,
    lastSeq,
    options,
    authTokenHash,
  );
}
