// @ts-check
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

const pages = [
  { name: 'home', hash: '' },
  { name: 'users', hash: '#users' },
  { name: 'resources', hash: '#resources' },
  { name: 'systems', hash: '#systems' },
];

for (const p of pages) {
  test(`visual regression: ${p.name}`, async ({ page }) => {
    await page.goto(`${BASE}/${p.hash}`);
    await page.waitForLoadState('networkidle');
    // Wait for content to stabilize
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${p.name}.png`, {
      maxDiffPixelRatio: 0.05,
      fullPage: true,
    });
  });
}
