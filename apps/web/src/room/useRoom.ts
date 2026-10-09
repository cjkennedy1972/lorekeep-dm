import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createRoomClient, type RoomClientOptions } from './client.js';

export function useRoom(opts: RoomClientOptions) {
  const { baseUrl } = opts;
  const onMessageRef = useRef(opts.onMessage);
  onMessageRef.current = opts.onMessage;
  const onMessage = useMemo(
    () => (message: Parameters<NonNullable<typeof opts.onMessage>>[0]) =>
      onMessageRef.current?.(message),
    [],
  );
  const client = useMemo(
    () => createRoomClient({ ...opts, baseUrl, onMessage }),
    [baseUrl, onMessage],
  ); // ponytail: other opts fixed per mount
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return { ...snapshot, send: client.send };
}
