import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Party browser e2e against the real server (Room + Postgres + scripted DM, no network).
// Needs DATABASE_URL (migrated). Run: pnpm --filter @game/web exec playwright test -c playwright.party.config.ts
const stateFile = resolve('test-results/party-live-state.json');
const apiPort = Number(process.env.LIVE_API_PORT ?? 8800);
const webPort = Number(process.env.LIVE_WEB_PORT ?? 5176);
process.env.LIVE_STATE_FILE = stateFile;

export default defineConfig({
  testDir: './e2e-party',
  workers: 1,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  outputDir: 'test-results/party',
  webServer: [
    {
      command:
        'pnpm --filter @game/server exec vitest run -c vitest.party.live.config.ts',
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
