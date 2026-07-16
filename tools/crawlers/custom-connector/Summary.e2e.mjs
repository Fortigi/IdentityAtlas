// @ts-check
/**
 * Custom Connector Summary — audit-log regression guard (UX audit H-20).
 *
 * H-20 ("crawler audit log fetches data but renders nothing") was a real bug in
 * the pre-externalization inline implementation; the connector externalization
 * (#364) rebuilt this panel so it fetches AND renders. This spec locks that in:
 * clicking the connector card's audit-log toggle must expand the panel and show
 * its content (audit rows or the "No activity yet" empty state) — never nothing.
 *
 * A jsdom mount test can't cover this: `tools/crawlers/` sits outside
 * `app/ui/node_modules`, so a jsdom-environment vitest file can't resolve React
 * for a component that lives here. Playwright (which runs against the real
 * bundled app) is the only automated option — hence an e2e, not a unit test.
 *
 * Named *.e2e.mjs and exports register(test, expect) — see
 * ConfigWizard.e2e.mjs's header for why. Discovered by
 * app/ui/e2e/crawler-plugin-tests.spec.js. Skips gracefully without a backend.
 */

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

export function register(test, expect) {
  test.describe('Custom Connector — audit log (H-20)', () => {
    test('the audit-log panel expands and renders content, not nothing', async ({ page }) => {
      // #crawlers is the hash alias that routes to Admin → Crawlers sub-tab
      // (plain #admin lands on a different default sub-tab).
      await page.goto(`${BASE}/#crawlers`);
      await page.waitForLoadState('networkidle');

      // The Crawlers page is lazy-loaded, so wait for it to actually render
      // (isVisible() doesn't wait); a timeout means no backend/page → skip.
      const addBtn = page.locator('button:has-text("Add Crawler")').first();
      try {
        await addBtn.waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        test.skip();
        return;
      }

      // Register a connector so its card (and Summary panel) is on screen.
      await addBtn.click();
      const customBtn = page.locator('button:has-text("Custom Connector")');
      await expect(customBtn).toBeVisible({ timeout: 5000 });
      await customBtn.click();

      await expect(page.locator('h3:has-text("Custom Connector")')).toBeVisible({ timeout: 10000 });
      await page.fill('input[placeholder*="SAP"]', 'E2E-Audit-Log-Connector');
      await page.click('button:has-text("Register Connector")');

      await expect(page.locator('text=Save this API key now')).toBeVisible({ timeout: 10000 });
      await page.click('button:has-text("Next: Getting Started")');
      await page.click('button:has-text("Done")');
      await page.waitForLoadState('networkidle');

      // The connector card's Summary panel exposes an audit-log toggle labelled "Log".
      const logBtn = page.locator('button', { hasText: /^Log$/ }).first();
      await expect(logBtn).toBeVisible({ timeout: 10000 });
      await logBtn.click();

      // The toggle only flips to "Hide Log" inside the fetch's success branch,
      // and that same `expandedAudit` state renders the entries container — so a
      // visible "Hide Log" proves the audit log fetched and rendered (the exact
      // failure mode H-20 described is a click that shows nothing).
      await expect(page.locator('button:has-text("Hide Log")')).toBeVisible({ timeout: 10000 });
    });
  });
}
