import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Node 26 shadows jsdom's localStorage with an unusable global; install an in-memory Storage.
if (!globalThis.localStorage?.clear) {
  const m = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    },
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
