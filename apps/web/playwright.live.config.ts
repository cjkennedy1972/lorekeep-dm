import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser e2e against the real server (Room + Postgres + scripted/recorded DM, no network).
// Needs DATABASE_URL (migrated). Run: pnpm --filter @game/web exec playwright test -c playwright.live.config.ts
const stateFile = resolve('test-results/live-state.json');
const apiPort = 8799;
const webPort = 5174;
process.env.LIVE_STATE_FILE = stateFile;

export default defineConfig({
  testDir: './e2e-live',
  workers: 1,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  outputDir: 'test-results/live',
  webServer: [
    {
      command:
        'pnpm --filter @game/server exec vitest run -c vitest.live.config.ts',
      url: `http://127.0.0.1:${apiPort}/api/me`, // 401 once up; any HTTP answer counts
      env: {
        LIVE_STATE_FILE: stateFile,
        LIVE_PORT: String(apiPort),
        DATABASE_URL: process.env.DATABASE_URL ?? '',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Same-origin proxy: the server checks the WebSocket Origin against Host.
      command: `pnpm exec vite --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      env: {
        VITE_API_URL: `http://localhost:${webPort}`,
        LIVE_API_TARGET: `http://127.0.0.1:${apiPort}`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
