import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRoomClient, type RoomClientOptions } from './client.js';

export function useRoom(opts: RoomClientOptions) {
  const { baseUrl } = opts;
  const client = useMemo(
    () => createRoomClient({ ...opts, baseUrl }),
    [baseUrl],
  ); // ponytail: other opts fixed per mount
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return { ...snapshot, send: client.send };
}
