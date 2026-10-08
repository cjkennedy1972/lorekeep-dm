import { defineConfig, devices } from '@playwright/test';

const crossBrowser = /(sandbox-combat|cross-browser|axe)\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  // Firefox/WebKit run only the cross-browser specs: the other existing specs
  // assume Chromium (Tab stops on macOS Safari, clipboard permissions); see
  // docs/plan/verification/m2-07-browsers.md.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: crossBrowser,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: crossBrowser,
    },
  ],
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
