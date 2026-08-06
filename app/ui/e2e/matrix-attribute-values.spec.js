// @ts-check
//
// Reporter path for #928 — "Group cannot be found using description property".
//
// Matrix → Adjust matrix → Next → Next → + Attribute → description → browse the
// values: a group description that exists in the data (it shows on the Excel
// export's Resources tab) was missing from the list, because the API served an
// arbitrary page of 500 distinct values with no way to reach the rest.
//
// The target here is picked from the data at run time: the alphabetically LAST
// stored description. The value list is now the alphabetically FIRST page, so
// on any dataset large enough to be capped that value is exactly the one the
// old code dropped — and on a small dataset it is simply a value that must be
// selectable. Either way the search must find it.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// The alphabetically last resource description in the deployment under test.
async function lastDescription() {
  const res = await fetch(`${API}/resources?sort=description&dir=desc&limit=1`);
  if (!res.ok) return null;
  const body = await res.json();
  const desc = body?.data?.[0]?.description;
  return typeof desc === 'string' && desc.trim() ? desc : null;
}

// A distinctive slice of the value to type into the search box.
function needleFor(description) {
  const trimmed = description.trim();
  return trimmed.length > 24 ? trimmed.slice(0, 24) : trimmed;
}

test.describe('#928 — matrix wizard attribute values', () => {
  test.setTimeout(90000);

  test('the description value list is a flagged page, never an arbitrary subset', async () => {
    const res = await fetch(`${API}/matrix/columns?entity=Resource`);
    expect(res.ok).toBeTruthy();
    const columns = await res.json();
    const description = columns.find(c => c.column === 'description');
    test.skip(!description, 'no description column discovered in this deployment');

    // The page is capped, and the cap is declared rather than silent.
    expect(description.values.length).toBeLessThanOrEqual(500);
    expect(typeof description.truncated).toBe('boolean');
    if (description.values.length === 500) expect(description.truncated).toBe(true);

    // Whatever it serves is the alphabetical prefix — the property a user
    // browsing the list alphabetically relies on.
    const sorted = [...description.values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(description.values).toEqual(sorted);
  });

  test('every stored description is findable through the value search', async () => {
    const target = await lastDescription();
    test.skip(!target, 'no resource with a description in this deployment');

    const res = await fetch(
      `${API}/matrix/column-values?entity=Resource&column=description`
      + `&q=${encodeURIComponent(needleFor(target))}`,
    );
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body.values).toContain(target);
  });

  test('the wizard picker finds that description and adds it as a filter', async ({ page }) => {
    const target = await lastDescription();
    test.skip(!target, 'no resource with a description in this deployment');
    const needle = needleFor(target);

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

    // Field → description. The count carries a "+" when the list is capped.
    const fieldSelect = page.getByLabel('Field');
    await fieldSelect.selectOption('description');

    // Browse the list for the value: type it into the search box. For a capped
    // column this queries the server, which is what makes an out-of-page value
    // reachable at all.
    await page.getByLabel('Search values').fill(needle);

    const option = page.getByRole('checkbox', { name: target });
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.check();

    await page.getByRole('button', { name: 'Add' }).click();

    // The condition lands as a chip on the Resources step.
    await expect(page.getByText(target, { exact: false }).first()).toBeVisible();
  });
});
