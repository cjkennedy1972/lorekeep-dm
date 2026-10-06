import type { RoomRegistry } from './registry.js';

export function installGracefulDrain(
  registry: Pick<RoomRegistry, 'drain'>,
  shutdown: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let draining = false;
  const handler = () => {
    if (draining) return;
    draining = true;
    void registry
      .drain()
      .then(shutdown)
      .then(
        () => exit(0),
        () => exit(1),
      );
  };
  process.on('SIGTERM', handler);
  return () => process.off('SIGTERM', handler);
}
