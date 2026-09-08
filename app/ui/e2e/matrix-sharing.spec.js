// @ts-check
//
// Sharing a matrix with a business user (#1166), end to end against a live
// deployment: an analyst mints a link from the matrix toolbar, a recipient
// opens it and sees the matrix in a bare shell, drills into a resource, and
// the sharer can see the usage and revoke the link again.
//
// Dataset-independent: the share is built from whatever default saved filter
// the deployment under test has, so this runs against the demo dataset or a
// real tenant alike.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// The deployment's default saved filter (or its first one) — the filter an
// analyst would be looking at when they share.
async function defaultFilter() {
  const res = await fetch(`${API}/matrix/saved-filters`);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows.find(r => r.isDefault) || rows[0]).filter;
}

// Mint a share straight through the API — the recipient-side tests care about
// what a link opens, not about how it was created (that has its own test).
async function createShare(name) {
  const filter = await defaultFilter();
  if (!filter) return null;
  const res = await fetch(`${API}/matrix/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, filter, managed: 'all', displayMode: 'grid' }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function revokeShare(id) {
  await fetch(`${API}/matrix/shares/${id}/revoke`, { method: 'POST' });
}

test.describe('Share a matrix (#1166)', () => {
  // Same cold-start allowance as the other matrix specs: the first matrix
  // query in CI can take 20-30s.
  test.setTimeout(90000);

  test('analyst mints a share link from the matrix toolbar', async ({ page }) => {
    test.slow();
    await page.goto(`${BASE}/#matrix`);

    const shareView = page.getByRole('button', { name: 'Share view…' });
    await expect(shareView).toBeVisible({ timeout: 60000 });
    await shareView.click();

    await page.getByLabel('Name this view').fill('E2E — analyst share');
    await page.getByRole('button', { name: 'Create link' }).click();

    // The link is shown exactly once, in full, so the sharer can copy it.
    await expect(page.getByRole('heading', { name: 'Share link created' })).toBeVisible({ timeout: 30000 });
    const url = await page.locator('p.font-mono').innerText();
    expect(url).toContain('#shared:fgs_');

    // …and what it opens is the recipient's shell, not the app.
    await page.goto(url);
    await expect(page.getByText('Shared matrix')).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('E2E — analyst share')).toBeVisible();
  });

  test('recipient sees the matrix and nothing else', async ({ page }) => {
    test.slow();
    const share = await createShare('E2E — recipient view');
    test.skip(!share, 'deployment has no saved matrix filter to share');

    await page.goto(`${BASE}/#shared:${share.token}`);

    // The matrix itself renders…
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('E2E — recipient view')).toBeVisible();

    // …inside a shell with none of the analyst's tooling: no top-level
    // navigation, no way to change the matrix, no export or re-share.
    await expect(page.getByRole('button', { name: 'Dashboard' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Contexts' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Adjust filter/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export Excel' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share view…' })).toHaveCount(0);

    // The one view control a business user does get: the governed toggle.
    await expect(page.getByRole('button', { name: 'All', exact: true }).first()).toBeVisible();
  });

  test('recipient can drill into a resource and come back', async ({ page }) => {
    test.slow();
    const share = await createShare('E2E — drilldown');
    test.skip(!share, 'deployment has no saved matrix filter to share');

    await page.goto(`${BASE}/#shared:${share.token}`);
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });

    // The resource name in a row is the drill-down affordance — clicking it is
    // the "click on resources and get details" the issue asks for.
    const nameCell = page.locator('table tbody tr').first().getByRole('cell').first();
    const resourceName = (await nameCell.innerText()).trim();
    test.skip(!resourceName, 'matrix rendered no resource rows');
    await nameCell.getByText(resourceName, { exact: true }).click();

    // The detail page opens inside the shell, with the analyst-only tabs gone.
    const back = page.getByRole('button', { name: 'Back to matrix' });
    await expect(back).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('heading', { name: resourceName }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: /Timeline/i })).toHaveCount(0);
    // Drill-down stays inside the shared shell — the token is still the route.
    expect(page.url()).toContain(`#shared:${share.token}`);

    await back.click();
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });
  });

  test('a revoked link tells the recipient plainly, and usage is kept', async ({ page }) => {
    const share = await createShare('E2E — revoked');
    test.skip(!share, 'deployment has no saved matrix filter to share');

    // Open it once so there is usage history to survive the revoke.
    await page.goto(`${BASE}/#shared:${share.token}`);
    await expect(page.getByText('E2E — revoked')).toBeVisible({ timeout: 60000 });

    await revokeShare(share.id);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This view is no longer shared' }))
      .toBeVisible({ timeout: 30000 });

    // Revoking is a soft flag: the share and its usage stay on the overview.
    const rows = await (await fetch(`${API}/matrix/shares`)).json();
    const revoked = rows.find(r => r.id === share.id);
    expect(revoked.revokedAt).toBeTruthy();
    expect(revoked.accessCount).toBeGreaterThan(0);
  });

  test('an unknown token never reveals whether it existed', async ({ page }) => {
    await page.goto(`${BASE}/#shared:fgs_thisisnotarealsharetokenatallxxxxxxxxxxxxx`);
    await expect(page.getByRole('heading', { name: /doesn’t open a shared view/ }))
      .toBeVisible({ timeout: 30000 });
  });

  test('Shared matrices page lists the share and can revoke it', async ({ page }) => {
    const share = await createShare('E2E — overview row');
    test.skip(!share, 'deployment has no saved matrix filter to share');

    await page.goto(`${BASE}/#shared-matrices`);
    const row = page.locator('tr', { hasText: 'E2E — overview row' }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    // Never opened is the signal the page exists for.
    await expect(row.getByText('Never opened')).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke link' }).click();
    await expect(row.getByText('Revoked')).toBeVisible({ timeout: 30000 });
  });
});
