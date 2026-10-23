// @ts-check
/**
 * An account a sync has removed is not an orphan (#1442).
 *
 * Reported symptom: after a full sync ran a second time with some users missing
 * from the source, those removed accounts were still listed by Reports →
 * Orphaned Accounts, still scored by Admin → Account Linking → Run now, and
 * still counted in the run's "orphans remaining". A full sync does not delete a
 * principal that vanished from its source — it stamps `deletedAt` and keeps the
 * row for history — and the orphan-set definition did not filter those out.
 *
 * This spec walks exactly the reporter's path against the running stack, and
 * seeds the state the report needs, because the demo dataset deliberately
 * contains no removed accounts (its leaver is a *disabled* account):
 *
 *   1. register an ingest connector and a system of its own;
 *   2. full-sync two orphan accounts into it — both live;
 *   3. see both of them in Reports → Orphaned Accounts (the control: the report
 *      can show them, so their later absence means something);
 *   4. full-sync again with one of them missing — what the reporter did;
 *   5. the report now lists the live account and not the removed one;
 *   6. run Account Linking from Admin and confirm the removed account was not
 *      attached to the identity it matches, while its live twin was.
 *
 * Everything the spec seeds lives in its own system, under fixed ids, so a
 * re-run reuses the same rows instead of accumulating new ones, and the final
 * cleanup removes the identity and tombstones the accounts.
 *
 * Serial: the steps share seeded state, and the linking run in the second test
 * attaches the live account — which would remove it from the orphan report the
 * first test asserts on.
 */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// ROWS_PER_PAGE in src/components/reports/ListReportRenderer.jsx. Restated
// rather than imported: Playwright does not transpile that JSX module.
const ROWS_PER_PAGE = 100;

// The fixture's own system, keyed on (systemType, tenantId) — the ingest key for
// a system — so every run upserts this one row instead of registering another.
const SYSTEM = { displayName: 'E2E — removed-account fixture', systemType: 'e2e', tenantId: 'e2e-1442' };

// Fixed ids, for the same reason. The display names deliberately match none of
// the Admin/Guest/Service/Shared classification patterns, so both accounts
// classify as `Secondary` and the only thing separating them is the sync.
const LIVE = {
  id: '1442e2e0-0000-4000-8000-000000000001',
  displayName: 'Euson, Robin (e2e-1442 live)',
  email: 'robin.euson.e2e1442@e2e.invalid',
};
const DEPARTED = {
  id: '1442e2e0-0000-4000-8000-000000000002',
  displayName: 'Euson, Robin (e2e-1442 removed)',
  email: 'robin.euson.e2e1442.removed@e2e.invalid',
};
const IDENTITY = { id: '1442e2e0-0000-4000-8000-000000000003', displayName: 'Robin Euson (e2e-1442)' };
// Both accounts and the identity share this, so each scores the employeeId
// signal (weight 95) against the identity and nothing else in the dataset.
const EMPLOYEE_ID = 'E2E-1442-EMP';

let apiKey = null;    // the ingest key, issued once per run
let crawlerId = null;
let systemId = null;
/** Why the fixture could not be set up, if it could not — each test skips on it. */
let unavailable = null;

const json = (res) => res.json().catch(() => ({}));

/** An ingest call as the registered connector. */
async function ingest(entity, body) {
  const res = await fetch(`${API}/ingest/${entity}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, body: await json(res) };
}

/**
 * A full principals sync carrying exactly `accounts`. Any other principal of
 * this system is reconciled away — stamped `deletedAt`, which is the state the
 * whole report is about.
 */
function syncAccounts(accounts) {
  return ingest('principals', {
    systemId,
    syncMode: 'full',
    records: accounts.map(a => ({
      id: a.id,
      displayName: a.displayName,
      email: a.email,
      employeeId: EMPLOYEE_ID,
      principalType: 'User',
      accountEnabled: true,
    })),
  });
}

/** The Orphaned Accounts report as the API serves it — every row, not just a page. */
async function orphanReport() {
  const res = await fetch(`${API}/reports/orphaned-accounts/rows`);
  expect(res.ok, 'GET /api/reports/orphaned-accounts/rows should succeed').toBe(true);
  return res.json();
}

const orphanNames = (report) => report.rows.map(r => r.displayName);

/** The principals currently attached to the fixture's identity. */
async function linkedPrincipalIds() {
  const res = await fetch(`${API}/identities/${IDENTITY.id}`);
  if (!res.ok) return [];
  return ((await res.json()).members || []).map(m => m.principalId);
}

test.beforeAll(async () => {
  // One connector per run; its key is returned once and never again.
  const res = await fetch(`${API}/admin/crawlers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: `e2e-1442-ingest-${Date.now()}`,
      description: 'Temporary ingest key for the removed-account orphan spec (#1442).',
      permissions: ['ingest'],
    }),
  });
  if (res.status !== 201) {
    // Mock mode (USE_SQL=false) has no Crawlers table and no ingest to drive.
    unavailable = `could not register an ingest connector (HTTP ${res.status})`;
    return;
  }
  const crawler = await res.json();
  apiKey = crawler.apiKey;
  crawlerId = crawler.id;

  const system = await ingest('systems', { syncMode: 'delta', records: [SYSTEM] });
  systemId = system.body.systemIds?.[0];
  if (!systemId) {
    unavailable = `could not register the fixture system (HTTP ${system.status})`;
    return;
  }

  // The person both accounts belong to. Delta, never full: identities are not
  // scoped to a system, so a full sync here would reconcile the whole table.
  const identity = await ingest('identities', {
    systemId,
    syncMode: 'delta',
    records: [{ id: IDENTITY.id, displayName: IDENTITY.displayName, employeeId: EMPLOYEE_ID }],
  });
  if (!identity.ok) unavailable = `could not seed the fixture identity (HTTP ${identity.status})`;
});

test.afterAll(async () => {
  if (!apiKey) return;
  // Hard-delete the identity (cascades its IdentityMembers rows) so a re-run
  // starts with both accounts orphaned again, then tombstone the accounts so
  // nothing this spec seeded shows up on any live surface.
  if (systemId) {
    await ingest('identities', { systemId, syncMode: 'delta', records: [], deletedIds: [IDENTITY.id] });
    await syncAccounts([]);
  }
  await fetch(`${API}/admin/crawlers/${crawlerId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permanent: true }),
  });
});

test.beforeEach(async () => {
  test.skip(!!unavailable, String(unavailable));
});

/** Reports → Orphaned Accounts, opened the way a reader opens it. */
async function openOrphanReport(page, report) {
  await page.goto(`${BASE}/#reports`);
  await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible({ timeout: 30000 });
  await page.getByRole('link', { name: report.displayName }).click();
  await expect(page.getByRole('heading', { name: report.displayName, level: 2 })).toBeVisible({ timeout: 30000 });
  // The table holds one page of whatever the API just returned.
  await expect(page.getByText(new RegExp(`^${report.total} rows?`))).toBeVisible({ timeout: 15000 });
}

/** Which page of the table is on screen, from the pager's own label (0-based). */
async function currentPage(page) {
  const pager = page.getByText(/^Page \d+ of \d+$/);
  if (await pager.count() === 0) return 0;              // single page — no pager drawn
  const label = await pager.innerText();
  return Number(label.match(/^Page (\d+)/)[1]) - 1;
}

/**
 * Page to the page holding `displayName` and return its cell. Which page that is
 * comes from the API's own ordering, so the spec does not depend on where a
 * dataset happens to put the fixture's accounts — and it steps either way, so
 * two rows can be revealed in any order.
 */
async function revealRow(page, report, displayName) {
  const index = orphanNames(report).indexOf(displayName);
  expect(index, `${displayName} should be in the report the API just served`).toBeGreaterThanOrEqual(0);
  const target = Math.floor(index / ROWS_PER_PAGE);
  for (let at = await currentPage(page); at !== target; at = await currentPage(page)) {
    await page.getByRole('button', { name: at < target ? 'Next' : 'Prev' }).click();
  }
  return page.getByRole('button', { name: displayName, exact: true });
}

test.describe('Orphaned Accounts and an account the sync removed', () => {
  test('the report lists a live orphan and drops the one the sync removed', async ({ page }) => {
    // Sync 1 — both accounts exist in the source, so both are live orphans.
    expect((await syncAccounts([LIVE, DEPARTED])).ok).toBe(true);

    const before = await orphanReport();
    expect(orphanNames(before)).toContain(LIVE.displayName);
    expect(orphanNames(before)).toContain(DEPARTED.displayName);

    // The control: both are really on the page the reader looks at. Without it,
    // their absence after the removal would prove nothing — a report that broke
    // entirely would look like a pass.
    await openOrphanReport(page, before);
    await expect(await revealRow(page, before, LIVE.displayName)).toBeVisible();
    await expect(await revealRow(page, before, DEPARTED.displayName)).toBeVisible();

    // Sync 2 — the second account is gone from the source. The ingest stamps
    // `deletedAt` on it rather than deleting the row.
    expect((await syncAccounts([LIVE])).ok).toBe(true);

    const after = await orphanReport();
    // This is the bug: the removed account used to come back here as an orphan.
    expect(orphanNames(after)).not.toContain(DEPARTED.displayName);
    expect(orphanNames(after)).toContain(LIVE.displayName);

    // And the reader sees the same: the live account still listed, the removed
    // one nowhere in the table.
    await openOrphanReport(page, after);
    await expect(await revealRow(page, after, LIVE.displayName)).toBeVisible();
    await expect(page.getByRole('button', { name: DEPARTED.displayName, exact: true })).toHaveCount(0);
  });

  test('Account Linking attaches the live account and never the removed one', async ({ page }) => {
    const config = await (await fetch(`${API}/account-linking/config`)).json();
    const rules = config.rules || {};
    // The live twin links on its employeeId (an exact signal, weight 95). A
    // tenant that raised the threshold past it, or that stopped linking plain
    // secondary accounts, has no control to assert — and without the control
    // the regression half of this test is not discriminating.
    test.skip(
      !(rules.onlyLinkTypes || []).includes('Secondary') || (rules.linkThreshold ?? 0) > 95,
      'the deployment\'s linking rules would not link the live control account',
    );

    // Re-seed from scratch: both accounts live, then one removed by a full sync,
    // so the removed account is a tombstone *before* linking ever sees it.
    expect((await syncAccounts([LIVE, DEPARTED])).ok).toBe(true);
    expect((await syncAccounts([LIVE])).ok).toBe(true);
    expect(await linkedPrincipalIds()).not.toContain(DEPARTED.id);

    await page.goto(`${BASE}/#admin?sub=account-linking`);
    const runNow = page.getByRole('button', { name: 'Run now' });
    await expect(runNow).toBeVisible({ timeout: 30000 });
    await runNow.click();

    // The page polls the run and reports the outcome when it finishes.
    await expect(page.getByText(/Linking complete/)).toBeVisible({ timeout: 120000 });
    await expect(page.getByText(/orphans remaining/)).toBeVisible();

    // Control and regression in one assertion: the live account was attached to
    // the person it matches, the removed one was not — even though it carries
    // the same employeeId and would have scored identically.
    expect(await linkedPrincipalIds()).toEqual([LIVE.id]);

    // The removed account is not outstanding work either: it is absent from the
    // orphan report the run leaves behind.
    expect(orphanNames(await orphanReport())).not.toContain(DEPARTED.displayName);
  });
});
