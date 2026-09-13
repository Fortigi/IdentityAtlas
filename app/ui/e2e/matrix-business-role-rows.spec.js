// @ts-check
//
// #937 — "Don't show Business Roles as a row in the matrix".
//
// A governed assignment is a real Direct membership on the business role
// itself, so before this change the same role appeared twice in one matrix:
// as a governance (SOLL) column AND as an ordinary resource row. Business
// roles are now off the resource axis by default, with a matrix-level opt-in
// ("Show business roles as foldable rows" on the wizard's Resources step) for the
// deliberate "which access packages do people hold" matrix.
//
// Run against the live, demo-data-loaded app. Everything is read from the
// deployment at run time, so the spec is dataset-independent; it skips when the
// deployment carries no business roles at all (AC 9, the empty case).

import { test, expect } from '@playwright/test';
import { BASE, API } from './matrixWizard.js';

const EMPTY_SCOPE = { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } };

async function matrixData(filter) {
  const res = await fetch(`${API}/matrix/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { ...EMPTY_SCOPE, ...filter } }),
  });
  expect(res.ok, `POST /matrix/data returned ${res.status}`).toBeTruthy();
  return res.json();
}

// One business role from the deployment, or null when it ships none.
async function aBusinessRole() {
  const res = await fetch(`${API}/resources?resourceType=BusinessRole&limit=1`);
  if (!res.ok) return null;
  return (await res.json())?.data?.[0] || null;
}

const businessRoleRows = (body) => (body.data || []).filter(r => r.resourceType === 'BusinessRole');

test.describe('#937 — business roles are not matrix rows', () => {
  test.setTimeout(120000);

  test('the default matrix has no business-role rows, but still has group rows', async () => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    const body = await matrixData({});
    expect(businessRoleRows(body)).toHaveLength(0);
    // Not vacuous: the grid still returns the actual-access rows it should.
    expect((body.data || []).length).toBeGreaterThan(0);
  });

  test('the governance columns and their colouring survive the exclusion', async () => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    const body = await matrixData({});
    // The SOLL side is keyed by the CONTAINED resource, not the role, so it is
    // unaffected — this is the half that must not disappear with the rows.
    expect(Array.isArray(body.managedByPackages)).toBeTruthy();
    expect(body.managedByPackages.length).toBeGreaterThan(0);
    expect(body.data.some(r => r.managedByAccessPackage)).toBeTruthy();
  });

  test('the opt-in flag brings the rows back, and the counts follow it', async () => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    const hidden = await matrixData({});
    const shown  = await matrixData({ includeBusinessRoles: true });

    expect(businessRoleRows(shown).length).toBeGreaterThan(0);
    // Counts track the rendered rows in both directions (AC 5 / 6).
    expect(shown.resourceCount).toBeGreaterThan(hidden.resourceCount);
    expect(shown.resourceTotal).toBeGreaterThan(hidden.resourceTotal);
  });

  test('an explicit resourceType scope still builds an access-package matrix', async () => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    // Asking for the type by name is the analyst overriding the default on
    // purpose (#931) — no flag needed.
    const body = await matrixData({
      resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['BusinessRole'] }], exclude: [] },
    });
    expect(businessRoleRows(body).length).toBeGreaterThan(0);
    expect(body.data.every(r => r.resourceType === 'BusinessRole')).toBeTruthy();
  });

  test('ownership rows are untouched by the exclusion', async () => {
    const res = await fetch(`${API}/resources?resourceType=GroupOwnership&limit=1`);
    const owner = res.ok ? (await res.json())?.data?.[0] : null;
    test.skip(!owner, 'no ownership resources in this deployment');

    const body = await matrixData({});
    expect((body.data || []).some(r => r.resourceType === 'GroupOwnership')).toBeTruthy();
  });

  test('the wizard offers the opt-in, off by default, and raises the preview count', async ({ page }) => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    await page.goto(`${BASE}/#matrix`);
    await page.waitForLoadState('networkidle');

    const openWizard = page.getByRole('button', { name: /Create matrix|Adjust matrix/ }).first();
    await expect(openWizard).toBeVisible({ timeout: 60000 });
    await openWizard.click();

    // Setup → Subjects → Resources.
    const next = page.getByRole('button', { name: 'Next' });
    await expect(next).toBeVisible({ timeout: 30000 });
    await next.click();
    await next.click();

    const checkbox = page.getByRole('checkbox', { name: /Show business roles as foldable rows/i });
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    // The live summary's resource count is the wizard's own view of the row
    // set, so it must move when the flag does.
    // `.last()` is the innermost matching node — the outer summary bar matches
    // the same regex but its text starts with the subject count.
    const summary = page.getByText(/of [\d,]+ resources/).last();
    await expect(summary).toBeVisible({ timeout: 30000 });
    const readCount = async () => {
      const text = await summary.innerText();
      return parseInt(text.replace(/,/g, '').match(/(\d+)\s+of/)?.[1] ?? '0', 10);
    };
    const before = await readCount();

    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await expect.poll(readCount, { timeout: 30000 }).toBeGreaterThan(before);
  });

  // The other half of the opt-in (#370): the fold layer arrives WITH the rows
  // and only with them. A default matrix must carry none of it — no fold
  // buttons, no chips, no markers that only a role row can produce. The
  // opted-in grid is exercised in full by matrix.spec.js.
  test('the default grid carries no business-role fold layer at all', async ({ page }) => {
    const role = await aBusinessRole();
    test.skip(!role, 'no business roles in this deployment');

    const filter = { rowType: 'principal', orientation: 'rows-as-resources', ...EMPTY_SCOPE };
    await page.goto(`${BASE}/#matrix?filter=` + encodeURIComponent(JSON.stringify(filter)));
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(1000); // let the virtualiser settle

    await expect(page.getByRole('button', { name: 'Fold roles', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fold business role resources' })).toHaveCount(0);
    await expect(page.locator('button[title^="Also granted by business role:"]')).toHaveCount(0);
    await expect(page.locator('tbody td[title*="Granted by business role:"]')).toHaveCount(0);
    await expect(page.locator('tbody span[title*="More than the business role assigns"]')).toHaveCount(0);
    await expect(page.locator('tbody span[title*="Held outside business-role governance"]')).toHaveCount(0);

    // Not vacuous: the grid itself rendered, and the legend still explains the
    // markers a default matrix CAN draw.
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText('Provisioning gap')).toBeVisible();
  });
});
