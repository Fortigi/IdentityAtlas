import { defineConfig, devices } from '@playwright/test';

/**
 * FortigiGraph UI E2E Tests - Playwright Configuration
 *
 * Starts both backend (mock mode) and frontend dev server,
 * then runs browser tests against the full stack.
 *
 * Usage:
 *   cd UI/frontend
 *   npx playwright install chromium    # first time only
 *   npx playwright test                # run all tests
 *   npx playwright test --ui           # interactive test runner
 *   npx playwright test --headed       # see the browser
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 30000,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Start backend (mock mode) and frontend dev server */
  webServer: [
    {
      command: 'node src/index.js',
      cwd: '../api',
      port: 3001,
      env: {
        USE_SQL: 'false',
        AUTH_ENABLED: 'false',
        PORT: '3001',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
    },
    {
      command: 'npx vite --port 5173',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
    },
  ],
});
