import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve('apps/server'),
  test: {
    include: ['test/live/serve.adventure.live.ts'],
    testTimeout: 0,
    hookTimeout: 120_000,
  },
});
