// @ts-check
//
// Saving and sharing a matrix as one experience (#1202, on top of #1166), end to
// end against a live deployment: an analyst saves-and-shares in a single act
// under a single name, sees the shared state on the matrix afterwards, changes
// who it is for without the link changing, and stops sharing — while the
// recipient always sees the matrix as it currently stands.
//
// Dataset-independent: shares are built from whatever default saved filter the
// deployment under test has, so this runs against the demo dataset or a real
// tenant alike.

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
async function someRecipient(skip = 0) {
  const res = await fetch(`${API}/users?limit=25`);
  if (!res.ok) return null;
  const body = await res.json();
  const rows = (body?.data || []).filter(r => r.userPrincipalName || r.email);
  const row = rows[skip];
  if (!row) return null;
  return { principalId: row.id, userKey: row.userPrincipalName || row.email, displayName: row.displayName };
}

// Save-and-share straight through the API — the recipient-side specs care about
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
  const share = await res.json();
  return { ...share, address: share.shareAddress || share.id, recipient };
}

async function revokeShare(id) {
  await fetch(`${API}/matrix/shares/${id}/revoke`, { method: 'POST' });
}

async function deleteSavedMatrix(id) {
  if (id) await fetch(`${API}/matrix/saved-filters/${id}`, { method: 'DELETE' });
}

// Drive the share form. Both entry points — the wizard's final step and the
// matrix bar's dialog — render the SAME panel, so the steps to drive it belong
// in one place; if they ever have to diverge, that is a signal the two entry
// points have drifted apart and the divergence deserves its own test.
//
// Naming the people is not optional: the share button stays disabled until the
// share has somebody to open it, which is asserted here on the way through.
async function fillShareForm(page, { name, recipient }) {
  const share = page.getByRole('button', { name: name ? 'Save & share' : 'Share matrix' });

  if (name) {
    // Asserted before filling: `fill` waits for the field for the whole test
    // timeout, so a matrix that is unexpectedly already saved (no name asked)
    // used to hang this spec for six minutes instead of failing on the reason.
    const nameField = page.getByLabel('Name this matrix');
    await expect(nameField, 'the matrix is unsaved, so the share form asks for a name').toBeVisible({ timeout: 15000 });
    await nameField.fill(name);
  } else {
    // Already saved: the one thing #1202 forbids is asking for the name twice.
    await expect(page.getByLabel('Name this matrix')).toHaveCount(0);
  }

  await expect(share).toBeDisabled();
  await page.getByLabel('Share with', { exact: true }).fill(recipient.userKey);
  const result = page.getByRole('group', { name: 'Search results' }).getByRole('button').first();
  await expect(result).toBeVisible({ timeout: 30000 });
  await result.click();
  await expect(page.getByRole('list', { name: 'Selected people' })).toContainText(recipient.displayName);

  await expect(share).toBeEnabled();
  await share.click();
}

test.describe('Save and share a matrix as one act (#1202)', () => {
  // Same cold-start allowance as the other matrix specs: the first matrix
  // query in CI can take 20-30s.
  test.setTimeout(120000);

  // The headline of the issue: one name, and afterwards the matrix is BOTH
  // saved and shared — and says so.
  test('one name saves and shares, and the matrix then shows it is shared', async ({ page }) => {
    test.slow();
    const recipient = await someRecipient();
    test.skip(!recipient, 'deployment has no directory user to share with');
    const name = `E2E — one name ${Date.now()}`;

    // The wizard opens on whatever the matrix shows — on the demo data that is
    // the saved default, which (rightly) shares without asking for a name. Make
    // it a NEW matrix first: switching the rows to identities is a real change
    // on any dataset, so no saved matrix matches it any more.
    await openWizard(page);
    // The Setup card, not the top-nav tab of the same name: its accessible
    // name carries the description after the title.
    await page.getByRole('button', { name: /^Identities\s*Each subject is one correlated person/ }).click();
    await gotoWizardStep(page, 'Share');
    await expect(page.getByText('Share this matrix (optional)')).toBeVisible({ timeout: 30000 });

    await fillShareForm(page, { name, recipient });

    // The link is shown, addressed by share id (so it is copyable again later).
    await expect(page.locator('p.font-mono')).toBeVisible({ timeout: 30000 });
    const url = await page.locator('p.font-mono').innerText();
    expect(url).toContain('#shared:');
    expect(url).not.toContain('#shared:fgs_');
    await expect(page.getByRole('button', { name: 'Copy share link' })).toBeVisible();

    // It was SAVED too — under that same one name, nothing else asked for.
    const saved = await (await fetch(`${API}/matrix/saved-filters`)).json();
    const row = saved.find(r => r.name === name);
    expect(row).toBeTruthy();
    expect(row.shared).toBe(true);
    expect(row.recipientCount).toBe(1);

    // Apply it, and the matrix bar says both things without opening anything.
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(name)).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole('button', { name: /Shared with 1 person/ })).toBeVisible();

    await deleteSavedMatrix(row.id);
  });

  // The repro from the issue: "Adjust matrix" on a shared matrix used to show
  // no sign at all that it was shared.
  test('"Adjust matrix" on a shared matrix shows the share and can change it', async ({ page }) => {
    test.slow();
    const share = await createShare(`E2E — adjust shared ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');
    const other = await someRecipient(1);
    test.skip(!other, 'deployment has only one directory user');

    // Load the shared matrix into the view, then reopen the wizard on it.
    await page.goto(`${BASE}/#matrix`);
    await page.getByRole('button', { name: /Load matrix/ }).click({ timeout: 60000 });
    // A shared entry's accessible name is "<name> Shared with N people", so
    // match the name as a prefix — an exact match waits out the test timeout.
    const entry = page.getByRole('button', { name: new RegExp(`^${share.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
    await expect(entry).toBeVisible({ timeout: 30000 });
    await entry.click();
    await expect(page.getByRole('button', { name: /Shared with 1 person/ })).toBeVisible({ timeout: 60000 });

    await page.getByRole('button', { name: 'Adjust matrix' }).click();
    await gotoWizardStep(page, 'Share');
    await expect(page.getByText(/Shared with 1 person/)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();

    // Add the second person: same link, one more recipient.
    await page.getByLabel('Shared with', { exact: true }).fill(other.userKey);
    await page.getByRole('group', { name: 'Search results' }).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Save recipients' }).click();

    await expect.poll(async () => {
      const rows = await (await fetch(`${API}/matrix/shares`)).json();
      return rows.find(r => r.id === share.id)?.recipients?.length;
    }, { timeout: 30000 }).toBe(2);

    // The link itself never changed — that is what "adjust in place" means.
    const rows = await (await fetch(`${API}/matrix/shares`)).json();
    expect(rows.find(r => r.id === share.id).id).toBe(share.address);

    // Deleting revokes too — and leaves no saved matrix behind to twin the next run's.
    await deleteSavedMatrix(share.savedFilterId);
  });

  test('a removed recipient loses access, on a link that never changed', async () => {
    const share = await createShare(`E2E — recipient swap ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');
    const other = await someRecipient(1);
    test.skip(!other, 'deployment has only one directory user');

    const res = await fetch(`${API}/matrix/shares/${share.id}/recipients`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [other] }),
    });
    expect(res.status).toBe(200);

    const rows = await (await fetch(`${API}/matrix/shares`)).json();
    const updated = rows.find(r => r.id === share.id);
    expect(updated.recipients.map(r => r.userKey)).toEqual([other.userKey.toLowerCase()]);
    expect(updated.revokedAt).toBeNull();

    // Empty is refused — a share nobody can open is not a share.
    const empty = await fetch(`${API}/matrix/shares/${share.id}/recipients`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [] }),
    });
    expect(empty.status).toBe(400);

    // Deleting revokes too — and leaves no saved matrix behind to twin the next run's.
    await deleteSavedMatrix(share.savedFilterId);
  });

  // Reverses #1166's snapshot decision, on the record: the recipient tracks the
  // live saved matrix.
  test('the recipient sees the matrix as it stands, not as it was shared', async ({ page }) => {
    test.slow();
    const share = await createShare(`E2E — live view ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');
    const renamed = `${share.name} (renamed)`;

    await page.goto(`${BASE}/#shared:${share.address}`);
    await expect(page.getByText(share.name)).toBeVisible({ timeout: 60000 });

    await fetch(`${API}/matrix/saved-filters/${share.savedFilterId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renamed }),
    });

    await page.reload();
    await expect(page.getByText(renamed)).toBeVisible({ timeout: 60000 });

    // Deleting revokes too — and leaves no saved matrix behind to twin the next run's.
    await deleteSavedMatrix(share.savedFilterId);
  });

  test('recipient sees the matrix and nothing else', async ({ page }) => {
    test.slow();
    const share = await createShare(`E2E — recipient view ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');

    await page.goto(`${BASE}/#shared:${share.address}`);

    // The matrix itself renders…
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(share.name)).toBeVisible();

    // …inside a shell with none of the analyst's tooling: no top-level
    // navigation, no way to change the matrix, no export, no save bar.
    await expect(page.getByRole('button', { name: 'Dashboard' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Contexts' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Adjust matrix/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export Excel' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Load matrix/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Shared with/ })).toHaveCount(0);
    // Nor the analyst context around the matrix: scope strip and scope stats.
    await expect(page.getByText('User × Resource')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Trends & breakdown/i })).toHaveCount(0);

    // The one view control a business user does get: the governed toggle.
    await expect(page.getByRole('button', { name: 'All', exact: true }).first()).toBeVisible();

    // Deleting revokes too — and leaves no saved matrix behind to twin the next run's.
    await deleteSavedMatrix(share.savedFilterId);
  });

  test('recipient can drill into a resource and come back', async ({ page }) => {
    test.slow();
    const share = await createShare(`E2E — drilldown ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');

    await page.goto(`${BASE}/#shared:${share.address}`);
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
    // Drill-down stays inside the shared shell — the address is still the route.
    expect(page.url()).toContain(`#shared:${share.address}`);

    await back.click();
    await expect(page.locator('table').first()).toBeVisible({ timeout: 60000 });

    // Deleting revokes too — and leaves no saved matrix behind to twin the next run's.
    await deleteSavedMatrix(share.savedFilterId);
  });

  test('stopping sharing closes the link but keeps the saved matrix', async ({ page }) => {
    const share = await createShare(`E2E — stop sharing ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');

    // Open it once so there is usage history to survive the revoke.
    await page.goto(`${BASE}/#shared:${share.address}`);
    await expect(page.getByText(share.name)).toBeVisible({ timeout: 60000 });

    await revokeShare(share.id);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This view is no longer shared' }))
      .toBeVisible({ timeout: 30000 });

    // Revoking is a soft flag: the share and its usage stay on the overview…
    const rows = await (await fetch(`${API}/matrix/shares`)).json();
    const revoked = rows.find(r => r.id === share.id);
    expect(revoked.revokedAt).toBeTruthy();
    expect(revoked.accessCount).toBeGreaterThan(0);

    // …and the saved matrix survives, now reading as not shared.
    const saved = await (await fetch(`${API}/matrix/saved-filters`)).json();
    const row = saved.find(r => r.id === share.savedFilterId);
    expect(row).toBeTruthy();
    expect(row.shared).toBe(false);

    await deleteSavedMatrix(share.savedFilterId);
  });

  test('a name that is already taken is refused, never silently overwritten', async () => {
    const share = await createShare(`E2E — clash ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');
    const [filter, recipient] = await Promise.all([defaultFilter(), someRecipient()]);

    const res = await fetch(`${API}/matrix/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: share.name, filter, recipients: [recipient] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/i);

    // The original is untouched — exactly one saved matrix under that name.
    const saved = await (await fetch(`${API}/matrix/saved-filters`)).json();
    expect(saved.filter(r => r.name === share.name)).toHaveLength(1);

    await revokeShare(share.id);
    await deleteSavedMatrix(share.savedFilterId);
  });

  test('an unknown address never reveals whether it existed', async ({ page }) => {
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

  test('Shared matrices page manages the share and can revoke it', async ({ page }) => {
    const share = await createShare(`E2E — overview row ${Date.now()}`);
    test.skip(!share, 'deployment has no saved matrix filter to share');

    // The pre-move #shared-matrices link still resolves — to the Admin sub-tab.
    await page.goto(`${BASE}/#shared-matrices`);
    const row = page.locator('tr', { hasText: share.name }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    // Never opened is the signal the page exists for.
    await expect(row.getByText('Never opened')).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();

    // Manage expands the same panel the matrix and the wizard host — including
    // the link, copyable long after it was minted.
    await row.getByRole('button', { name: 'Manage' }).click();
    await expect(page.getByText(`#shared:${share.address}`)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Copy share link' })).toBeVisible();

    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke link' }).click();
    await expect(row.getByText('Revoked')).toBeVisible({ timeout: 30000 });

    await deleteSavedMatrix(share.savedFilterId);
  });
});
