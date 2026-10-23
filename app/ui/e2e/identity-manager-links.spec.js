// @ts-check
//
// An identity's manager, on the running app (#1216).
//
// The reported symptom: open Reports → Missing Managers and *every* person in
// the tenant is listed under Type "Identity", even the ones whose org chart is
// fully populated and whose account half of the same report is clean. Nobody
// can be asked to certify anybody's access, and the one report that exists to
// find that gap points at everyone, so it points at nobody.
//
// The cause was a level below the UI: the Entra crawler stamped the account's
// manager (`Principals.managerId`) but never the person's
// (`Identities.managerIdentityId`), so the identity half of the report was
// vacuously true for the whole directory.
//
// Both halves of that report are read off ONE source fetch — the full sync's
// `$expand=manager` — so the two levels must agree: an identity whose account
// has a manager must have a manager identity. That agreement is the assertion
// here, and it is derived from the deployment's own data rather than from
// hard-coded names, so the spec runs against the demo dataset or a real tenant
// alike. Before the fix every single identity violated it.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// The report draws one page at a time — ROWS_PER_PAGE in
// src/components/reports/ListReportRenderer.jsx. Restated here because
// Playwright does not transpile the JSX module that owns it.
const ROWS_PER_PAGE = 100;

const REPORT = 'missing-managers';

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`);
  expect(res.ok, `GET ${path} should succeed`).toBe(true);
  return res.json();
}

const names = list => list.map(i => i.displayName).sort();

/**
 * Who has a manager, at both levels, as the deployment under test sees it.
 *
 * Identities and principals are correlated here by `employeeId` — the field the
 * demo dataset and a real HR-fed tenant both carry on the person and on the
 * account — because the identity list surfaces no manager column of its own
 * (that is the whole point of the report).
 */
async function managerPicture() {
  const [identities, users, report] = await Promise.all([
    fetchJson('/identities?limit=1000'),
    fetchJson('/users?limit=1000'),
    fetchJson(`/reports/${REPORT}/rows`),
  ]);

  const accountsByEmployeeId = new Map();
  for (const user of users.data) {
    if (!user.employeeId) continue;
    const list = accountsByEmployeeId.get(user.employeeId) || [];
    list.push(user);
    accountsByEmployeeId.set(user.employeeId, list);
  }

  // An identity is "account-managed" when at least one of its accounts names a
  // manager. Anyone correlated to no account at all is neither managed nor
  // unmanaged: the source never said, so the report is free either way.
  const managed = [];
  const unmanaged = [];
  for (const identity of identities.data) {
    const accounts = accountsByEmployeeId.get(identity.employeeId) || [];
    if (!accounts.length) continue;
    (accounts.some(a => a.managerId) ? managed : unmanaged).push(identity);
  }

  const identityRows = report.rows.filter(r => r.rowType === 'Identity');
  return { identities: identities.data, managed, unmanaged, report, identityRows };
}

test.describe('Missing Managers — the identity half (#1216)', () => {
  test('an identity whose account has a manager is not reported as managerless', async () => {
    const { managed, unmanaged, identityRows } = await managerPicture();

    // Without this the rest of the test would pass on an empty tenant while
    // proving nothing: the bug was *every* identity being listed, so the
    // dataset has to contain identities that ought not to be.
    expect(managed.length, 'dataset should hold identities whose account names a manager').toBeGreaterThan(0);

    const reported = new Set(identityRows.map(r => r._entity.id));
    const wrongly = managed.filter(i => reported.has(i.id)).map(i => i.displayName);
    expect(wrongly, 'identities with a manager account must have a manager identity too').toEqual([]);

    // The other direction: the fix must not have bought a clean report by
    // clearing the column for everyone. The genuine gaps — the top of the org
    // chart, the leaver whose manager left with them — are still listed, and
    // the identity half is exactly those.
    expect(names(identityRows)).toEqual(names(unmanaged));
  });

  test('the report page lists only the genuinely managerless people', async ({ page }) => {
    const { managed, unmanaged, report } = await managerPicture();
    expect(managed.length, 'dataset should hold identities whose account names a manager').toBeGreaterThan(0);

    await page.goto(`${BASE}/#reports`);
    await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible({ timeout: 30000 });
    await page.getByRole('link', { name: report.displayName }).click();

    await expect(page).toHaveURL(new RegExp(`#report:${REPORT}`));
    await expect(page.getByRole('heading', { name: report.displayName, level: 2 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(new RegExp(`^${report.total} rows?`))).toBeVisible({ timeout: 15000 });

    // Read the rendered table, not the API response again: the reporter's
    // complaint was about what the page showed. Name and Type are the first two
    // columns the report declares.
    const rendered = await page.locator('table tbody tr').evaluateAll(trs => trs.map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
      return { name: cells[0], type: cells[1] };
    }));
    expect(rendered.length).toBe(Math.min(report.total, ROWS_PER_PAGE));

    // A name can legitimately appear twice — once per level — so the rows are
    // matched on the Type cell, not on the name alone.
    const shownAsIdentity = rendered.filter(r => r.type === 'Identity').map(r => r.name).sort();
    if (report.total <= ROWS_PER_PAGE) {
      expect(shownAsIdentity).toEqual(names(unmanaged));
    }
    for (const identity of managed) {
      expect(shownAsIdentity, `${identity.displayName} has a manager and must not be listed`)
        .not.toContain(identity.displayName);
    }

    // The finding is actionable: the identity row opens that person's detail
    // tab, which is how a reviewer gets from "nobody can certify this" to the
    // person. Addressed by row index rather than by name — the same person can
    // hold both a reported account and a reported identity, and clicking the
    // first button bearing their name would open the account tab instead.
    const identityRow = rendered.findIndex(r => r.type === 'Identity');
    test.skip(identityRow < 0, 'no managerless identity on the first page of this dataset');
    await page.locator('table tbody tr').nth(identityRow).getByRole('button').click();
    await expect(page).toHaveURL(/#identity:/);
  });
});
