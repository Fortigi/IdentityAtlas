// @ts-check
//
// An identity's manager, on the running app (#1216).
//
// The reported symptom: open Reports → Missing Managers and *every* person was
// listed under Type "Identity", even the ones whose org chart was fully
// populated. The cause was a level below the UI: nothing stamped
// `Identities.managerIdentityId`, so the identity half of the report was
// vacuously true for everyone.
//
// This spec seeds its own people through the ingest API instead of reading the
// demo dataset. The shared dataset is not stable across a suite run: a spec that
// imports HR identities as a full sync reconciles the whole Identities table
// (it has no systemId to scope by), so the demo identities can be gone by the
// time this spec runs. Owning the fixture also lets it say exactly who must and
// must not be listed:
//
//   • the manager    — top of the chart, no manager        → listed
//   • the report     — managed by the manager              → NOT listed
//   • the orphan     — names a manager nobody loaded       → listed (link cleared)
//   • the self-loop  — names themselves as manager         → listed (link cleared)
//
// The last two are the ingest's manager-link repair for identities: a link that
// points at nobody must not read as "has a manager".
//
// Seeded as DELTA batches, so this spec never reconciles anybody else's rows.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { API, BASE, openIngestSession, closeIngestSession } from './accountLinkingSeed.js';

// The report draws one page at a time — ROWS_PER_PAGE in
// src/components/reports/ListReportRenderer.jsx. Restated here because
// Playwright does not transpile the JSX module that owns it.
const ROWS_PER_PAGE = 100;
const REPORT = 'missing-managers';

const token = randomUUID().slice(0, 8);
const person = (role, extra = {}) => ({
  id: randomUUID(),
  displayName: `E2E 1216 ${role} ${token}`,
  department: 'E2E #1216',
  ...extra,
});

const manager = person('Manager');
const report = person('Report', { managerIdentityId: manager.id });
const orphan = person('Orphan', { managerIdentityId: randomUUID() });
const selfLoop = person('SelfLoop');
selfLoop.managerIdentityId = selfLoop.id;

const FIXTURE = [manager, report, orphan, selfLoop];
const MUST_BE_LISTED = [manager, orphan, selfLoop];

const literal = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** @type {any} */
let session;
/** @type {any} */
let ingestResult;

async function reportRows() {
  const res = await fetch(`${API}/reports/${REPORT}/rows`);
  expect(res.ok, `GET /reports/${REPORT}/rows should succeed`).toBe(true);
  return res.json();
}

test.describe.configure({ mode: 'serial' });

test.describe('Missing Managers — the identity half (#1216)', () => {
  test.beforeAll(async () => {
    session = await openIngestSession({
      displayName: `e2e-1216-${token}`,
      description: 'Throwaway key for the #1216 identity-manager E2E. Removed by the spec.',
      system: { systemType: 'HR', tenantId: `e2e-1216-${token}`, displayName: `E2E #1216 HR (${token})` },
    });
    if (session.ok) ingestResult = await session.mustIngest('identities', { records: FIXTURE });
  });

  test.afterAll(async () => {
    await closeIngestSession(session, {
      identityIds: FIXTURE.map(p => p.id),
      systemNote: 'Disabled leftover of the #1216 identity-manager E2E.',
    });
  });

  test('a manager link that points at nobody is cleared, and the ingest says so', async () => {
    test.skip(!session?.ok, session?.reason || 'ingest not available');
    // At least ours: the sweep is table-wide, so other leftovers may add to it.
    expect(ingestResult.managerLinks?.unresolved, "the orphan's link is cleared").toBeGreaterThanOrEqual(1);
    expect(ingestResult.managerLinks?.selfReferences, "the self-loop's link is cleared").toBeGreaterThanOrEqual(1);
  });

  test('the report lists exactly the managerless people of the fixture', async () => {
    test.skip(!session?.ok, session?.reason || 'ingest not available');
    const { rows } = await reportRows();
    const listed = new Set(rows.filter(r => r.rowType === 'Identity').map(r => r._entity.id));

    for (const p of MUST_BE_LISTED) {
      expect(listed.has(p.id), `${p.displayName} has no valid manager and must be listed`).toBe(true);
    }
    // The bug: an identity WITH a manager was listed as managerless.
    expect(listed.has(report.id), `${report.displayName} has a manager and must not be listed`).toBe(false);
  });

  test('the report page shows the same, and a row opens the person', async ({ page }) => {
    test.skip(!session?.ok, session?.reason || 'ingest not available');
    const data = await reportRows();
    // Rows render in API order, so the fixture's position on the page is known.
    const index = data.rows.findIndex(r => r.rowType === 'Identity' && r._entity.id === manager.id);
    expect(index, 'the manager is in the report').toBeGreaterThanOrEqual(0);
    test.skip(index >= ROWS_PER_PAGE, 'the fixture lands past the first page on this deployment');

    await page.goto(`${BASE}/#reports`);
    await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible({ timeout: 30000 });
    await page.getByRole('link', { name: literal(data.displayName) }).click();
    await expect(page).toHaveURL(new RegExp(`#report:${REPORT}`));
    await expect(page.getByText(new RegExp(`^${data.total} rows?`))).toBeVisible({ timeout: 15000 });

    const rows = page.locator('table tbody tr');
    const row = rows.nth(index);
    await expect(row.locator('td').nth(0)).toHaveText(manager.displayName);
    await expect(row.locator('td').nth(1)).toHaveText('Identity');
    // The managed report is not on the page at all.
    await expect(rows.filter({ hasText: report.displayName })).toHaveCount(0);

    await row.getByRole('button').click();
    await expect(page).toHaveURL(/#identity:/);
  });
});
