// @ts-check
//
// Custom reports — building one BY HAND, with no model server in the stack.
//
// That is the claim this spec exists for: the report builder is a query builder
// first. The "describe it in plain language" half needs the optional
// report-generator container, which the CI stack deliberately does not run, so
// here the assistant must say it is unavailable while everything else works.
//
// Covers the whole life cycle: new → criteria → preview → save → listed → run in
// its own tab → edit → delete.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;
const NAME = `E2E disabled accounts ${Date.now()}`;

/** Remove anything this spec left behind, whatever it failed on. */
async function deleteByName(name) {
  const res = await fetch(`${API}/reports`);
  if (!res.ok) return;
  const { data } = await res.json();
  for (const report of data.filter(r => r.editable && r.displayName === name)) {
    await fetch(`${API}/nl-reports/saved/${report.editable.builderId}`, { method: 'DELETE' });
  }
}

test.describe('custom reports', () => {
  test.afterEach(async () => {
    await deleteByName(NAME);
  });

  test('builds, saves, runs, edits and deletes a report without a model', async ({ page }) => {
    await page.goto(`${BASE}/#reports`);
    await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible({ timeout: 30000 });

    await page.getByRole('button', { name: 'New report' }).click();
    await expect(page).toHaveURL(/#report-builder:new-/);
    await expect(page.getByRole('heading', { name: /New report/ })).toBeVisible();

    // No model server in this stack: the assistant says so, the editor still works.
    await expect(page.getByText(/report generator is not available/i)).toBeVisible();

    await page.getByLabel('Name').fill(NAME);
    await page.getByLabel('Description').fill('Built by the end-to-end suite');

    // Report on users, disabled ones only.
    await page.getByLabel('Report on').selectOption('user');
    await page.getByRole('button', { name: '+ condition' }).first().click();
    await page.getByLabel('Field').selectOption('accountEnabled');
    await page.getByLabel('Enabled value').selectOption('false');

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText(/Users where/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Enabled is No/)).toBeVisible();

    await page.getByRole('button', { name: 'Save' }).click();
    // Saving swaps the "new" tab for the saved report's own builder tab.
    await expect(page).toHaveURL(/#report-builder:[0-9a-f]{8}-/, { timeout: 20000 });

    // It is now a report like any other: listed, and it runs in its own tab.
    await page.goto(`${BASE}/#reports`);
    const link = page.getByRole('link', { name: new RegExp(NAME) });
    await expect(link).toBeVisible({ timeout: 20000 });
    await link.click();
    await expect(page).toHaveURL(/#report:custom-/);
    await expect(page.getByRole('heading', { name: NAME, level: 2 })).toBeVisible({ timeout: 20000 });
    // Download buttons come from the API's advertised formats — a custom report
    // is served by the same route as a built-in one.
    await expect(page.getByRole('button', { name: /CSV/i })).toBeVisible();

    // Edit from the report itself, change the description, save again.
    // Scoped to the report's own tab: the Reports list stays mounted in its tab and
    // has an "Edit <name>" button for the same report.
    await page.getByRole('region', { name: NAME }).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Edit report/ })).toBeVisible({ timeout: 20000 });
    await page.getByLabel('Description').fill('Edited by the end-to-end suite');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText(/Saved/, { timeout: 20000 });

    // Delete it from the list and confirm it is gone.
    await page.goto(`${BASE}/#reports`);
    await page.getByRole('button', { name: `Delete ${NAME}` }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('link', { name: new RegExp(NAME) })).toHaveCount(0, { timeout: 20000 });
  });
});
