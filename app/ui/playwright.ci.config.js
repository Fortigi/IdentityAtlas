import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright CI Configuration — runs against the Docker backend.
 *
 * Unlike the default config (playwright.config.js) which starts its own
 * backend in mock mode + Vite dev server, this config expects the full
 * Docker stack (postgres + web + worker) to already be running on port 3001.
 *
 * The web container serves both the API and the built React frontend,
 * so no separate dev server is needed.
 *
 * Used by: .github/workflows/pr-integration.yml (E2E job)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 2,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 30000,

  use: {
    /* Docker web container serves frontend on port 3001 */
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* No webServer — Docker stack is already running */
});
