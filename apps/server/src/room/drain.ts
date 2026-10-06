export function installGracefulDrain(
  shutdown: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  onError: (error: unknown) => void = (error) => console.error(error),
): () => void {
  let draining = false;
  const handler = () => {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        await shutdown();
        exit(0);
      } catch (error) {
        onError(error);
        exit(1);
      }
    })();
  };
  process.once('SIGTERM', handler);
  return () => process.off('SIGTERM', handler);
}
