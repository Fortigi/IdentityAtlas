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
import { matrixColumn, openAttributePicker, resourceValue } from './matrixWizard.js';

test.describe('#927 — displayName as a matrix wizard attribute filter', () => {
  test.setTimeout(90000);

  test('the API serves displayName as a filterable column with values', async () => {
    const column = await matrixColumn('displayName');
    expect(column, 'displayName must be discovered for entity=Resource').toBeTruthy();
    expect(Array.isArray(column.values)).toBeTruthy();
    expect(column.values.length).toBeGreaterThan(0);
  });

  test('the Resources step offers displayName and filters the matrix by name', async ({ page }) => {
    // The alphabetically first resource name — the one value guaranteed to be
    // inside the preloaded first page of the column.
    const target = await resourceValue('displayName', 'asc');
    test.skip(!target, 'no named resource in this deployment');

    const fieldSelect = await openAttributePicker(page, 'resources');

    // The reporter's assertion: displayName is in the Field dropdown.
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
    const fieldSelect = await openAttributePicker(page, 'subjects');

    await expect(fieldSelect.locator('option[value="displayName"]')).toHaveCount(1);
  });
});
