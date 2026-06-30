// @ts-check
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ALL_NAV_TABS } from '../src/utils/navTabs.js';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

// Drift-proof page list: iterate the app's single source of truth for top-level
// pages (ALL_NAV_TABS) rather than a hardcoded copy. A new page MUST be added to
// ALL_NAV_TABS to appear in the nav, so it is automatically axe-checked here —
// nothing to forget to update. Enforced (#471): zero serious/critical WCAG
// 2A/2AA violations on every nav page (the global-setup enables optional tabs).
for (const tab of ALL_NAV_TABS) {
  test(`${tab.label} page has no critical accessibility violations`, async ({ page }) => {
    await page.goto(`${BASE}/#${tab.key}`);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const serious = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    expect(serious, `A11y violations on ${tab.label}: ${serious.map(v => v.id).join(', ')}`).toHaveLength(0);
  });
}

// Skip-to-content link: the first focusable element must let keyboard users
// jump past the nav to the main content (added with the a11y baseline).
test('a "Skip to main content" link targets the main region', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await expect(skip).toHaveAttribute('href', '#main-content');
  await expect(page.locator('#main-content')).toHaveCount(1);
});
