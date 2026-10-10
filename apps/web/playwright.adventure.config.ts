import { defineConfig, devices } from '@playwright/test';

const stateFile = resolve('test-results/adventure-live-state.json');
const apiPort = Number(process.env.LIVE_API_PORT ?? 8799);
const webPort = Number(process.env.LIVE_WEB_PORT ?? 5175);
process.env.LIVE_STATE_FILE = stateFile;
process.env.LIVE_API_PORT = String(apiPort);

export default defineConfig({
  testDir: './e2e-adventure',
  workers: 1,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
  outputDir: 'test-results/adventure',
  webServer: [
    {
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
