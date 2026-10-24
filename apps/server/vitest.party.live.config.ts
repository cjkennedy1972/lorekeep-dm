import { defineConfig } from 'vitest/config';

// Party browser e2e harness (round + host panels); see apps/web/playwright.party.config.ts.
export default defineConfig({
  test: {
    include: ['test/live/serve.party.live.ts'],
    testTimeout: 0,
    hookTimeout: 120_000,
  },
});
