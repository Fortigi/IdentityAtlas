// @ts-check
//
// Reports tab — the pluggable report framework, its first report, opening a
// report in its own tab, and downloading one.
//
// The assertions are driven by the deployment's own API (GET /api/reports and
// the rows endpoint) rather than by hard-coded report names or row counts, so
// the spec proves the page renders *whatever* the deployment registers. That is
// the feature: the UI never knows a report by name.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

/** The registered report templates, read from the deployment under test. */
async function fetchReports() {
  const res = await fetch(`${API}/reports`);
  expect(res.ok, 'GET /api/reports should succeed').toBe(true);
  return (await res.json()).data;
}

async function fetchRows(name) {
  const res = await fetch(`${API}/reports/${encodeURIComponent(name)}/rows`);
  expect(res.ok, `GET /api/reports/${name}/rows should succeed`).toBe(true);
  return res.json();
}

async function openReports(page) {
  await page.goto(`${BASE}/#reports`);
  await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible({ timeout: 30000 });
}

/** Open one report in its own tab, from the list. */
async function openReport(page, report) {
  await openReports(page);
  await page.getByRole('link', { name: new RegExp(report.displayName) }).click();
  await expect(page).toHaveURL(new RegExp(`#report:${report.name}`));
  await expect(page.getByRole('heading', { name: report.displayName, level: 2 })).toBeVisible({ timeout: 15000 });
}

test.describe('Reports', () => {
  test('Reports tab is in the navigation and opens the page', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const tab = page.getByRole('button', { name: 'Reports', exact: true });
    await expect(tab).toBeVisible({ timeout: 30000 });

    await tab.click();
    await expect(page).toHaveURL(/#reports/);
    await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible();
  });

  test('lists every registered report as a link, without running any of them', async ({ page }) => {
    const reports = await fetchReports();
    expect(reports.length, 'the deployment should register at least one report').toBeGreaterThan(0);

    await openReports(page);
    for (const report of reports) {
      const link = page.getByRole('link', { name: new RegExp(report.displayName) });
      await expect(link).toBeVisible();
      // A real link to the report's route, so it can also be opened in a browser tab.
      await expect(link).toHaveAttribute('href', `#report:${report.name}`);
    }
    // The list is a catalogue — no report content until one is opened.
    await expect(page.locator('table')).toHaveCount(0);
  });

  test('opening a report runs it in its own tab, with its columns and rows', async ({ page }) => {
    const body = await fetchRows('orphaned-accounts');
    await openReport(page, body);

    // Row count and generation time come from the response.
    await expect(page.getByText(new RegExp(`^${body.total} rows?`))).toBeVisible({ timeout: 15000 });

    if (body.total === 0) {
      // A legitimately empty report shows the empty state, never an error.
      await expect(page.getByText('No rows')).toBeVisible();
      return;
    }

    // Every declared column is a real table heading … (exact, so a label that is
    // a prefix of another — "Account" vs "Account type" — still matches one `th`)
    for (const column of body.columns) {
      await expect(page.getByRole('columnheader', { name: column.label, exact: true })).toBeVisible();
    }
    // … and the table holds exactly the rows the API returned.
    await expect(page.locator('table tbody tr')).toHaveCount(body.total);

    const first = body.rows[0];
    if (first.displayName) {
      await expect(page.getByRole('button', { name: first.displayName }).first()).toBeVisible();
    }
  });

  test('the report stays open as a tab of its own', async ({ page }) => {
    const body = await fetchRows('orphaned-accounts');
    await openReport(page, body);

    // The tab strip now carries the report next to the primary tabs …
    const tab = page.locator('nav').getByRole('button', { name: new RegExp(body.displayName) });
    await expect(tab).toBeVisible();

    // … and going back to the list doesn't close it.
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page).toHaveURL(/#reports$/);
    await expect(tab).toBeVisible();
  });

  test('a report row opens the account detail tab', async ({ page }) => {
    const body = await fetchRows('orphaned-accounts');
    test.skip(body.total === 0, 'no orphaned accounts in this dataset');

    const row = body.rows.find(r => r._entity && r.displayName);
    test.skip(!row, 'no linkable row in this dataset');

    await openReport(page, body);
    await page.getByRole('button', { name: row.displayName }).first().click();
    await expect(page).toHaveURL(new RegExp(`#${row._entity.kind}:`));
  });

  test('Refresh re-runs the report against the latest data', async ({ page }) => {
    const body = await fetchRows('orphaned-accounts');
    await openReport(page, body);

    const rowsRequest = page.waitForRequest(r => r.url().includes('/api/reports/') && r.url().includes('/rows'));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(await rowsRequest).toBeTruthy();

    // The refreshed content replaces the old one — no error panel, no crash.
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled({ timeout: 15000 });
    await expect(page.getByText(/^Error/)).toHaveCount(0);
    await expect(page.locator('nav')).toBeVisible();
  });

  test('Download CSV saves the report as a named file', async ({ page }) => {
    const body = await fetchRows('orphaned-accounts');
    await openReport(page, body);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.getByRole('button', { name: 'Download CSV' }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^identity-atlas-.*\.csv$/);
    expect(await download.path()).toBeTruthy();
    // A failed download reports itself on the page — there must be no such panel.
    await expect(page.getByText('Download failed')).toHaveCount(0);
  });

  test('the export endpoint serves the report as a CSV attachment', async ({ request }) => {
    const rows = await fetchRows('orphaned-accounts');
    const res = await request.get(`${API}/reports/orphaned-accounts/export`);

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="identity-atlas-.*\.csv"$/);

    const lines = (await res.text()).split('\r\n');
    // A header row of column labels, then one line per row the report found.
    expect(lines[0]).toBe(rows.columns.map(c => `"${c.label}"`).join(','));
    expect(lines).toHaveLength(rows.total + 1);
  });

  test('the export endpoint refuses a format it does not serve', async ({ request }) => {
    const res = await request.get(`${API}/reports/orphaned-accounts/export?format=pdf`);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('Unsupported export format');
  });

  test('an unknown report name is a 404, not a crash', async ({ request }) => {
    const res = await request.get(`${API}/reports/not-a-real-report/rows`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'Report not found' });

    const download = await request.get(`${API}/reports/not-a-real-report/export`);
    expect(download.status()).toBe(404);
  });
});
