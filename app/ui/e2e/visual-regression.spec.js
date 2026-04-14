// @ts-check
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

const pages = [
  { name: 'home', hash: '' },
  { name: 'users', hash: '#users' },
  { name: 'resources', hash: '#resources' },
  { name: 'systems', hash: '#systems' },
];

// Skipped: baselines are platform-specific (chromium-linux in CI vs
// chromium-win32 locally) and don't exist yet. Re-enable after committing
// baselines or adding a baseline-generation CI step.
for (const p of pages) {
  test.skip(`visual regression: ${p.name}`, async ({ page }) => {
    await page.goto(`${BASE}/${p.hash}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${p.name}.png`, {
      maxDiffPixelRatio: 0.05,
      fullPage: true,
    });
  });
}
