import { defineConfig } from 'vitest/config';

// Hosts the recorded-LLM server for the browser e2e (apps/web/playwright.live.config.ts).
export default defineConfig({
  test: {
    include: ['test/live/*.live.ts'],
    testTimeout: 0,
    hookTimeout: 120_000,
  },
});
