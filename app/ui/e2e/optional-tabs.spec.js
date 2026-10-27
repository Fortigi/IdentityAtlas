// @ts-check
//
// Contexts is an opt-in tab (like Systems, Identities and Logs): off until the
// user turns it on in Settings → Visible Tabs. These tests own the tab
// preferences, so they put every optional tab back afterwards for the rest of
// the suite.

import { test, expect } from '@playwright/test';
import { ALL_OPTIONAL_TABS, setVisibleTabs } from './global-setup.js';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

const withoutContexts = () => ALL_OPTIONAL_TABS.filter(t => t !== 'contexts');

async function waitForPrefs(page) {
  // Systems is still on, so seeing it proves preferences have loaded — before
  // they do, no optional tab is hidden yet and a "hidden" assertion is vacuous.
  await expect(page.getByRole('button', { name: 'Systems', exact: true })).toBeVisible({ timeout: 30000 });
}

test.describe('Contexts tab is optional', () => {
  test.afterEach(async () => {
    await setVisibleTabs(ALL_OPTIONAL_TABS);
  });

  test('is hidden until the user opts in, but still reachable by URL', async ({ page }) => {
    await setVisibleTabs(withoutContexts());
    await page.goto(`${BASE}/`);
    await waitForPrefs(page);
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Contexts', exact: true })).toHaveCount(0);

    // Hiding the tab only declutters the nav — the page itself still works.
    await page.goto(`${BASE}/#contexts`);
    await expect(page).toHaveURL(/#contexts/);
    await expect(page.locator('nav')).toBeVisible();
  });

  test('appears in the nav as soon as it is switched on in Settings', async ({ page }) => {
    await setVisibleTabs(withoutContexts());
    await page.goto(`${BASE}/`);
    await waitForPrefs(page);

    await page.getByTitle('Settings').click();
    await page.getByRole('switch', { name: 'Show Contexts tab' }).click();

    const tab = page.getByRole('navigation').getByRole('button', { name: 'Contexts', exact: true });
    await expect(tab).toBeVisible();

    // The preference stuck — it is still on after a reload, and the tab opens
    // the page.
    await page.reload();
    await expect(tab).toBeVisible({ timeout: 30000 });
    await tab.click();
    await expect(page).toHaveURL(/#contexts/);
  });
});
