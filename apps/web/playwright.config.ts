import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  webServer: [
    {
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm mock',
      url: 'http://localhost:8787/api/me', // 401 once up; any HTTP answer counts
      reuseExistingServer: true,
      ignoreHTTPSErrors: true,
    },
  ],
});
