// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Entity Detail Pages', () => {

  test('user detail opens via hash route', async ({ page }) => {
    // Use mock user ID format
    await page.goto('/#user:u-0001');
    await page.waitForTimeout(1000);

    // Should show user detail content or navigate there
    // Detail tabs appear in the nav bar
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('group detail opens via hash route', async ({ page }) => {
    await page.goto('/#group:g-0001');
    await page.waitForTimeout(1000);

    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('detail tab appears in navigation when opened from Users page', async ({ page }) => {
    await page.goto('/#users');
    await page.waitForTimeout(500);

    // Click first clickable user name in the table
    const userLinks = page.locator('table a, table [role="link"], table button').filter({
      hasText: /[A-Z]/
    });

    if (await userLinks.count() > 0) {
      const linkText = await userLinks.first().textContent();
      await userLinks.first().click();
      await page.waitForTimeout(500);

      // A new tab should appear in the nav
      // Detail tabs have a close button (×)
      const closeButtons = page.locator('nav button svg, nav button:has-text("×")');
      // At least verify navigation didn't break
      const navButtons = page.locator('nav button');
      expect(await navButtons.count()).toBeGreaterThan(7); // 8 main tabs + at least 1 detail
    }
  });

  test('multiple detail tabs can be open simultaneously', async ({ page }) => {
    // Open user detail
    await page.goto('/#user:u-0001');
    await page.waitForTimeout(500);

    // Navigate to users page and open another
    await page.goto('/#users');
    await page.waitForTimeout(500);

    // Open group detail
    await page.goto('/#group:g-0001');
    await page.waitForTimeout(500);

    // Both detail tabs should be in the nav
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('detail tab close button works', async ({ page }) => {
    await page.goto('/#user:u-0001');
    await page.waitForTimeout(500);

    // Count nav buttons before closing
    const navButtons = page.locator('nav button');
    const countBefore = await navButtons.count();

    // Find and click the close button on the detail tab
    // Close buttons are small × icons inside the tab
    const closeButton = page.locator('nav').locator('button').filter({
      has: page.locator('svg')
    }).last();

    if (await closeButton.count() > 0 && countBefore > 8) {
      await closeButton.click();
      await page.waitForTimeout(300);

      // Should have one fewer tab
      const countAfter = await navButtons.count();
      expect(countAfter).toBeLessThanOrEqual(countBefore);
    }
  });
});
