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
 *      attached to the identity it matches, while its live twin was;
 *   7. the same for the worst case the acceptance measurement of #1442 turned
 *      up — a leaver whose account matches a *different*, live person who
 *      happens to share their name, on the name alone. The leaver has no
 *      identity of their own, so that namesake is the only candidate and
 *      nothing ties: before the fix, the live namesake inherited the leaver's
 *      account and every grant on it.
 *
 * Everything the spec seeds lives in its own system, under fixed ids, so a
 * re-run reuses the same rows instead of accumulating new ones, and the final
 * cleanup removes the identities and tombstones the accounts.
 *
 * Serial: the steps share seeded state, and the linking run in the second test
 * attaches the live account — which would remove it from the orphan report the
 * first test asserts on.
 */

import { test, expect } from '@playwright/test';
import {
  BASE, openIngestSession, closeIngestSession, linkingRules,
  linkedPrincipalIds, orphanReport, runAccountLinkingFromAdmin,
} from './accountLinkingSeed';

test.describe.configure({ mode: 'serial' });

// ROWS_PER_PAGE in src/components/reports/ListReportRenderer.jsx. Restated
// rather than imported: Playwright does not transpile that JSX module.
const ROWS_PER_PAGE = 100;

// The fixture's own system, keyed on (systemType, tenantId) — the ingest key for
// a system — so every run upserts this one row instead of registering another.
const SYSTEM = { displayName: 'E2E — removed-account fixture', systemType: 'e2e', tenantId: 'e2e-1442' };

// Both twin accounts and their identity share this, so each scores the
// employeeId signal (weight 95) against the identity and nothing else in the
// dataset.
const EMPLOYEE_ID = 'E2E-1442-EMP';

// Fixed ids, for the same reason. The display names deliberately match none of
// the Admin/Guest/Service/Shared classification patterns, so both accounts
// classify as `Secondary` and the only thing separating them is the sync.
const LIVE = {
  id: '1442e2e0-0000-4000-8000-000000000001',
  displayName: 'Euson, Robin (e2e-1442 live)',
  email: 'robin.euson.e2e1442@e2e.invalid',
  employeeId: EMPLOYEE_ID,
};
const DEPARTED = {
  id: '1442e2e0-0000-4000-8000-000000000002',
  displayName: 'Euson, Robin (e2e-1442 removed)',
  email: 'robin.euson.e2e1442.removed@e2e.invalid',
  employeeId: EMPLOYEE_ID,
};
const IDENTITY = { id: '1442e2e0-0000-4000-8000-000000000003', displayName: 'Robin Euson (e2e-1442)' };

// The namesake pair. The leaver's account carries no employeeId and an email
// local part of its own, so the ONLY thing connecting it to this live person is
// the name they are both spelled with — the `fullName` signal, weight 60, over
// the default threshold of 50. `(left the company)` is a display-name qualifier
// the name parser strips, so both sides reduce to the same {jordy, van den
// hurke2e1442} and the match is at full-name strength.
const NAMESAKE = {
  id: '1442e2e0-0000-4000-8000-000000000004',
  displayName: 'Jordy van den Hurke2e1442 (e2e-1442)',
  email: 'jordy.hurke2e1442@e2e.invalid',
};
const NAMESAKE_DEPARTED = {
  id: '1442e2e0-0000-4000-8000-000000000005',
  displayName: 'van den Hurke2e1442, Jordy (left the company)',
  email: 'j.hurke2e1442.departed@e2e.invalid',
};

/** The ingest connector + system, opened once per run. */
let session = null;
/** Why the fixture could not be set up, if it could not — each test skips on it. */
let unavailable = null;

/**
 * A full principals sync carrying exactly `accounts`. Any other principal of
 * this system is reconciled away — stamped `deletedAt`, which is the state the
 * whole report is about.
 */
function syncAccounts(accounts) {
  return session.ingest('principals', {
    syncMode: 'full',
    records: accounts.map(a => ({
      id: a.id,
      displayName: a.displayName,
      email: a.email,
      // Only the twins carry one; the namesake pair must match on name alone.
      employeeId: a.employeeId ?? null,
      principalType: 'User',
      accountEnabled: true,
    })),
  });
}

/**
 * Tombstone every account this spec seeded, whatever state it is in.
 *
 * Not `syncAccounts([])`: an **unscoped** empty full batch is deliberately a
 * no-op ("nothing to say", see ingest/engine.js) rather than "this system has
 * nothing at all", so it would leave the fixture's accounts live. A delta
 * `deletedIds` stamps `deletedAt` on them — the same tombstone a reconcile
 * leaves — which is the state cleanup wants.
 */
function removeAllAccounts(accounts) {
  return session.ingest('principals', { deletedIds: accounts.map(a => a.id) });
}

/**
 * Seed a person. Delta, never full: identities are not scoped to a system, so a
 * full sync here would reconcile the whole table.
 */
function seedIdentity(identity) {
  return session.ingest('identities', { records: [identity] });
}

/** Hard-delete a person, which cascades their IdentityMembers rows. */
function dropIdentity(id) {
  return session.ingest('identities', { deletedIds: [id] });
}

const orphanNames = (report) => report.rows.map(r => r.displayName);

test.beforeAll(async () => {
  // One connector per run; its key is returned once and never again.
  session = await openIngestSession({
    displayName: `e2e-1442-ingest-${Date.now()}`,
    description: 'Temporary ingest key for the removed-account orphan spec (#1442).',
    system: SYSTEM,
  });
  if (!session.ok) {
    unavailable = session.reason;
    return;
  }

  // The person both twin accounts belong to, and the live namesake the
  // leaver's account must never reach.
  const identity = await seedIdentity({
    id: IDENTITY.id, displayName: IDENTITY.displayName, employeeId: EMPLOYEE_ID,
  });
  const namesake = await seedIdentity({
    id: NAMESAKE.id, displayName: NAMESAKE.displayName, email: NAMESAKE.email,
  });
  if (!identity.ok || !namesake.ok) {
    unavailable = `could not seed the fixture identities (HTTP ${identity.status}/${namesake.status})`;
  }
});

test.afterAll(async () => {
  // Tombstone the accounts so nothing this spec seeded shows up on any live surface, then
  // hard-delete the identities (which cascades their IdentityMembers rows) so a re-run
  // starts with every account orphaned again.
  if (session?.systemId) await removeAllAccounts([LIVE, DEPARTED, NAMESAKE_DEPARTED]);
  await closeIngestSession(session, { identityIds: [IDENTITY.id, NAMESAKE.id] });
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

/** Admin → Account Linking → Run now, plus the figure this spec reads off the notice. */
async function runLinkingFromAdmin(page) {
  await runAccountLinkingFromAdmin(page);
  await expect(page.getByText(/orphans remaining/)).toBeVisible();
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
    const rules = (await linkingRules()) || {};
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
    expect(await linkedPrincipalIds(IDENTITY.id)).not.toContain(DEPARTED.id);

    await runLinkingFromAdmin(page);

    // Control and regression in one assertion: the live account was attached to
    // the person it matches, the removed one was not — even though it carries
    // the same employeeId and would have scored identically.
    expect(await linkedPrincipalIds(IDENTITY.id)).toEqual([LIVE.id]);

    // The removed account is not outstanding work either: it is absent from the
    // orphan report the run leaves behind.
    expect(orphanNames(await orphanReport())).not.toContain(DEPARTED.displayName);
  });

  test('a removed leaver’s account is never attached to a live person of the same name', async ({ page }) => {
    const rules = (await linkingRules()) || {};
    // The leaver's account matches the namesake on `fullName` and nothing else,
    // so a tenant that raised the certainty slider above that weight would not
    // link it even while it is live — no control, no regression.
    const nameWeight = (rules.signals || []).find(s => s.name === 'fullName')?.weight ?? 0;
    test.skip(
      !(rules.onlyLinkTypes || []).includes('Secondary') || (rules.linkThreshold ?? 0) > nameWeight,
      'the deployment\'s linking rules would not link a name-only match',
    );

    // The control first: while the leaver's account is live, the shared name IS
    // enough — the engine cannot know the two Jordys are different people, which
    // is exactly why the removal has to be the thing that stops it. This is the
    // wrong link the base build made.
    expect((await syncAccounts([NAMESAKE_DEPARTED, LIVE])).ok).toBe(true);
    await runLinkingFromAdmin(page);
    expect(await linkedPrincipalIds(NAMESAKE.id)).toEqual([NAMESAKE_DEPARTED.id]);

    // Now unwind that link and replay the reporter's order instead: the account
    // was gone from the source before linking ever ran. Dropping and re-seeding
    // the namesake cascades the member row away, leaving the same two rows.
    expect((await dropIdentity(NAMESAKE.id)).ok).toBe(true);
    expect((await seedIdentity(NAMESAKE)).ok).toBe(true);
    expect(await linkedPrincipalIds(NAMESAKE.id)).toEqual([]);

    // The next full sync carries the rest of the population but not the leaver,
    // so the reconcile tombstones that account — it is removed, not deleted.
    expect((await syncAccounts([LIVE])).ok).toBe(true);

    await runLinkingFromAdmin(page);

    // The namesake does not inherit a leaver's account, or its access with it.
    expect(await linkedPrincipalIds(NAMESAKE.id)).toEqual([]);
    expect(orphanNames(await orphanReport())).not.toContain(NAMESAKE_DEPARTED.displayName);
  });
});
