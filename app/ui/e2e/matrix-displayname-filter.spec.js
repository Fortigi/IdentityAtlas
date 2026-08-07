// @ts-check
//
// Reporter path for #927 — "displayName (or similar) attribute not available in
// matrix wizard (3rd step, resource definition)".
//
// Matrix → Adjust matrix → Next → Next (Resources step) → "+ Attribute" in the
// Include section → open the Field dropdown. `displayName` was absent, so a
// resource could not be filtered by its name even though the API serves the
// column with its values and the filter SQL already accepts it.
//
// The target name is read from the deployment at run time (the alphabetically
// first resource name), so the spec is dataset-independent: it works on the
// demo dataset (SG-AllEmployees, SG-Engineering, …) and on a real tenant.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// The alphabetically first resource name in the deployment under test — the one
// value guaranteed to be inside the preloaded first page of the column.
async function firstResourceName() {
  const res = await fetch(`${API}/resources?sort=displayName&dir=asc&limit=1`);
  if (!res.ok) return null;
  const body = await res.json();
  const name = body?.data?.[0]?.displayName;
  return typeof name === 'string' && name.trim() ? name : null;
}

// The `displayName` entry of /matrix/columns, or null when the deployment has
// no such column.
async function displayNameColumn() {
  const res = await fetch(`${API}/matrix/columns?entity=Resource`);
  if (!res.ok) return null;
  return (await res.json()).find(c => c.column === 'displayName') || null;
}

test.describe('#927 — displayName as a matrix wizard attribute filter', () => {
  test.setTimeout(90000);

  test('the API serves displayName as a filterable column with values', async () => {
    const column = await displayNameColumn();
    expect(column, 'displayName must be discovered for entity=Resource').toBeTruthy();
    expect(Array.isArray(column.values)).toBeTruthy();
    expect(column.values.length).toBeGreaterThan(0);
  });

  test('the Resources step offers displayName and filters the matrix by name', async ({ page }) => {
    const target = await firstResourceName();
    test.skip(!target, 'no named resource in this deployment');

    await page.goto(`${BASE}/#matrix`);
    await page.waitForLoadState('networkidle');

    // Open the wizard — "Create matrix" on the empty state, "Adjust matrix"
    // once a matrix is loaded.
    const openWizard = page.getByRole('button', { name: /Create matrix|Adjust matrix/ }).first();
    await expect(openWizard).toBeVisible({ timeout: 60000 });
    await openWizard.click();

    // Setup → Subjects → Resources (the reporter's "Next, Next").
    const next = page.getByRole('button', { name: 'Next' });
    await expect(next).toBeVisible({ timeout: 30000 });
    await next.click();
    await next.click();

    // + Attribute on the resource Include list.
    await page.getByRole('button', { name: '+ Attribute' }).first().click();
    await expect(page.getByText('Add attribute filter')).toBeVisible();

    // The reporter's assertion: displayName is in the Field dropdown.
    const fieldSelect = page.getByLabel('Field');
    await expect(fieldSelect.locator('option[value="displayName"]')).toHaveCount(1);

    // And the condition is fully buildable: pick a resource by name.
    await fieldSelect.selectOption('displayName');
    await page.getByLabel('Search values').fill(target);

    const option = page.getByRole('checkbox', { name: target, exact: true });
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.check();

    await page.getByRole('button', { name: 'Add' }).click();

    // The condition lands as a chip on the Resources step.
    await expect(page.getByText(target, { exact: false }).first()).toBeVisible();
  });

  test('the subjects step offers displayName too', async ({ page }) => {
    await page.goto(`${BASE}/#matrix`);
    await page.waitForLoadState('networkidle');

    const openWizard = page.getByRole('button', { name: /Create matrix|Adjust matrix/ }).first();
    await expect(openWizard).toBeVisible({ timeout: 60000 });
    await openWizard.click();

    const next = page.getByRole('button', { name: 'Next' });
    await expect(next).toBeVisible({ timeout: 30000 });
    await next.click(); // Setup → Subjects

    await page.getByRole('button', { name: '+ Attribute' }).first().click();
    await expect(page.getByText('Add attribute filter')).toBeVisible();

    await expect(page.getByLabel('Field').locator('option[value="displayName"]')).toHaveCount(1);
  });
});
