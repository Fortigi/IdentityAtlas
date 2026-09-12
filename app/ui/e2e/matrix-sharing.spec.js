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
import { BASE, API, openWizard, gotoWizardStep } from './matrixWizard.js';

// The deployment's default saved filter (or its first one) — the filter an
// analyst would be looking at when they share.
async function defaultFilter() {
  const res = await fetch(`${API}/matrix/saved-filters`);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows.find(r => r.isDefault) || rows[0]).filter;
}

// Somebody from the deployment's own directory to address a share to. A share
// is always for NAMED people — there is no "anyone with the link" share — so
// every spec here needs a real recipient rather than a made-up address.
async function someRecipient() {
  const res = await fetch(`${API}/users?limit=25`);
  if (!res.ok) return null;
  const body = await res.json();
  const row = (body?.data || []).find(r => r.userPrincipalName || r.email);
  if (!row) return null;
  return { principalId: row.id, userKey: row.userPrincipalName || row.email, displayName: row.displayName };
}

// Mint a share straight through the API — the recipient-side tests care about
// what a link opens, not about how it was created (that has its own test).
async function createShare(name) {
  const [filter, recipient] = await Promise.all([defaultFilter(), someRecipient()]);
  if (!filter || !recipient) return null;
  const res = await fetch(`${API}/matrix/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, filter, managed: 'all', displayMode: 'grid', recipients: [recipient] }),
  });
  if (!res.ok) return null;
  return res.json();
}

// Fill the share form and mint the link. Both entry points — the wizard's final
// step and the toolbar dialog — render the SAME ShareMatrixForm, so the steps to
// drive it belong in one place; if they ever have to diverge, that is a signal the
// two entry points have drifted apart and the divergence deserves its own test.
//
// Naming the people is not optional: `Create link` stays disabled until the share
// has somebody to open it, which is asserted here on the way through.
async function fillShareForm(page, { name, recipient }) {
  await page.getByLabel('Name this view').fill(name);

  const createLink = page.getByRole('button', { name: 'Create link' });
  await expect(createLink).toBeDisabled();

  await page.getByLabel('Share with').fill(recipient.userKey);
  const results = page.getByRole('group', { name: 'Search results' });
  await results.getByRole('button').first().click();
  await expect(page.getByRole('list', { name: 'Selected people' })).toContainText(recipient.displayName);

  await expect(createLink).toBeEnabled();
  await createLink.click();
}

async function revokeShare(id) {
  await fetch(`${API}/matrix/shares/${id}/revoke`, { method: 'POST' });
}

test.describe('Share a matrix (#1166)', () => {
  // Same cold-start allowance as the other matrix specs: the first matrix
  // query in CI can take 20-30s.
  test.setTimeout(90000);

  // The wizard's own last step is the route the requestor asked for: an analyst
  // who builds a matrix *for* somebody shouldn't have to apply it and then go
  // hunting for a toolbar button.
  test('analyst mints a share link from the wizard\'s final Share step', async ({ page }) => {
    test.slow();
    const recipient = await someRecipient();
    test.skip(!recipient, 'deployment has no directory user to share with');

    await openWizard(page);
    await gotoWizardStep(page, 'Share');
    await expect(page.getByText('Share this matrix (optional)')).toBeVisible();

    // Specific people, not an open link: no recipient, no share.
    await fillShareForm(page, { name: 'E2E — wizard share step', recipient });

    // The link is shown once, with the copy control the requestor asked for…
    await expect(page.locator('p.font-mono')).toBeVisible({ timeout: 30000 });
    const url = await page.locator('p.font-mono').innerText();
    expect(url).toContain('#shared:fgs_');
    await expect(page.getByRole('button', { name: 'Copy share link' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Shared with' })).toContainText(recipient.displayName);

    // …and the step stays optional: Apply still commits the matrix from here.
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Share this matrix (optional)')).toBeHidden();

    await page.goto(url);
    await expect(page.getByText('E2E — wizard share step')).toBeVisible({ timeout: 60000 });
  });

  test('analyst mints a share link from the matrix toolbar', async ({ page }) => {
    test.slow();
    const recipient = await someRecipient();
    test.skip(!recipient, 'deployment has no directory user to share with');

    await page.goto(`${BASE}/#matrix`);

    const shareView = page.getByRole('button', { name: 'Share view…' });
    await expect(shareView).toBeVisible({ timeout: 60000 });
    await shareView.click();

    await fillShareForm(page, { name: 'E2E — analyst share', recipient });

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

  // Managing other people's share links is administration, so the overview is
  // an Admin sub-tab and NOT a top-level tab (requestor feedback on #1166).
  test('Shared matrices lives under Admin, not in the top navigation', async ({ page }) => {
    await page.goto(`${BASE}/#dashboard`);
    await expect(page.getByRole('button', { name: 'Admin' })).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole('button', { name: /^Shared matrices$/i })).toHaveCount(0);

    await page.goto(`${BASE}/#admin`);
    const tab = page.locator('[data-testid="admin-subtabs"]').getByRole('button', { name: 'Shared Matrices' });
    await expect(tab).toBeVisible({ timeout: 30000 });
    await tab.click();
    await expect(page.getByText(/Every matrix shared by a link/)).toBeVisible({ timeout: 30000 });
    expect(page.url()).toContain('#admin?sub=shares');
  });

  test('Shared matrices page lists the share and can revoke it', async ({ page }) => {
    const share = await createShare('E2E — overview row');
    test.skip(!share, 'deployment has no saved matrix filter to share');

    // The pre-move #shared-matrices link still resolves — to the Admin sub-tab.
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
