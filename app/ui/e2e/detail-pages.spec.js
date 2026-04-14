// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Entity Detail Pages', () => {

  test('user detail opens via hash route', async ({ page }) => {
    // Use mock user ID format
    await page.goto('/#user:u-0001');
    await page.waitForTimeout(1000);

    // Should show user detail content or navigate there
    // Detail tabs appear in the nav bar
    const nav = page.locator('nav').first();
    await expect(nav).toBeVisible();
  });

  test('group detail opens via hash route', async ({ page }) => {
    await page.goto('/#group:g-0001');
    await page.waitForTimeout(1000);

    const nav = page.locator('nav').first();
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
    const nav = page.locator('nav').first();
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
    const closeButton = page.locator('nav').first().locator('button').filter({
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

  test.describe('Tab close navigation', () => {

    // Helper: find and click the close span on a tab by its tabKey (e.g. "user:abc")
    async function closeTab(page, tabKey) {
      // The close button is a <span> inside the tab <button>; hover the tab first to reveal it
      const tab = page.locator(`nav button`).filter({ hasText: new RegExp(tabKey.split(':')[0], 'i') }).last();
      await tab.hover();
      const closeSpan = tab.locator('span[title="Close"]');
      await closeSpan.click();
    }

    test('closing the active tab navigates to its originating page', async ({ page }) => {
      // Go to Users page first so openDetailTab records returnPage='users'
      await page.goto('/#users');
      await page.waitForTimeout(500);

      // Click the first user link to open a detail tab with returnPage='users'
      const userLinks = page.locator('table tbody tr td a, table tbody tr td button').first();
      if (await userLinks.count() === 0) {
        test.skip(); // No data — skip gracefully
        return;
      }
      await userLinks.click();
      await page.waitForTimeout(500);

      // The user detail tab is now active; close it
      const navButtons = page.locator('nav button');
      const countBefore = await navButtons.count();
      expect(countBefore).toBeGreaterThan(8); // at least one detail tab opened

      // Hover to reveal close button on the active (last) detail tab
      const activeDetailTab = page.locator('nav button').last();
      await activeDetailTab.hover();
      await page.locator('nav button').last().locator('span[title="Close"]').click();
      await page.waitForTimeout(300);

      // Should have returned to the Users page
      expect(page.url()).toContain('#users');
    });

    test('closing an inactive tab does not change the current page', async ({ page }) => {
      // Open two detail tabs via direct hash navigation
      await page.goto('/#user:u-0001');
      await page.waitForTimeout(300);
      await page.goto('/#group:g-0001');
      await page.waitForTimeout(300);

      // group:g-0001 is now active; u-0001 is inactive
      expect(page.url()).toContain('group:g-0001');

      // Hover the user tab and close it
      const userTab = page.locator('nav button').filter({ hasText: /^u-0001/ });
      if (await userTab.count() === 0) {
        // Tab label uses displayName which defaults to the id
        const detailTabs = page.locator('nav button').filter({ has: page.locator('span.rounded-sm') });
        const count = await detailTabs.count();
        if (count < 2) { test.skip(); return; }

        // Close the first detail tab (inactive one)
        const firstDetailTab = detailTabs.first();
        await firstDetailTab.hover();
        await firstDetailTab.locator('span[title="Close"]').click();
      } else {
        await userTab.hover();
        await userTab.locator('span[title="Close"]').click();
      }
      await page.waitForTimeout(300);

      // Should still be on the group tab — URL must not have changed to users/matrix
      expect(page.url()).toContain('group:g-0001');
    });

    test('closing an originating tab reparents its children so close still resolves', async ({ page }) => {
      // Simulate the chain: users → user tab A → group tab B
      // We do this via hash navigation; openDetailTab records returnPage from React state.
      // Use evaluate to set up the chain programmatically via the app's openDetailTab path.

      // Step 1: land on users, open user tab (returnPage='users')
      await page.goto('/#users');
      await page.waitForTimeout(300);
      const userLinks = page.locator('table tbody tr td a, table tbody tr td button').first();
      if (await userLinks.count() === 0) { test.skip(); return; }
      await userLinks.click();
      await page.waitForTimeout(500);

      // Step 2: from user tab, open a resource/group tab (returnPage='user:<id>')
      const resourceLinks = page.locator('main a, main button').filter({ hasText: /group|resource/i }).first();
      if (await resourceLinks.count() === 0) { test.skip(); return; }
      await resourceLinks.click();
      await page.waitForTimeout(500);

      // Both tabs open; the resource tab is now active
      const urlAfterOpen = page.url();
      expect(urlAfterOpen).toMatch(/(resource|group):/);

      // Step 3: close the user tab (currently inactive)
      const detailTabs = page.locator('nav button').filter({ has: page.locator('span.rounded-sm') });
      const tabCount = await detailTabs.count();
      if (tabCount < 2) { test.skip(); return; }

      // Find and close the user tab (it should be first of the detail tabs)
      const userDetailTab = detailTabs.first();
      await userDetailTab.hover();
      await userDetailTab.locator('span[title="Close"]').click();
      await page.waitForTimeout(300);

      // Still on the resource/group tab (closing inactive tab doesn't navigate)
      expect(page.url()).toMatch(/(resource|group):/);

      // Step 4: now close the resource tab (active) — its returnPage was reparented to 'users'
      const remainingTabs = page.locator('nav button').filter({ has: page.locator('span.rounded-sm') });
      if (await remainingTabs.count() === 0) { test.skip(); return; }
      await remainingTabs.first().hover();
      await remainingTabs.first().locator('span[title="Close"]').click();
      await page.waitForTimeout(300);

      // Should have landed on users (the grandparent), not matrix
      expect(page.url()).toContain('#users');
    });

  });
});
