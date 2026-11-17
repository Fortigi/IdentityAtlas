// @ts-check
/**
 * A business role deleted in the source governs nothing (#1629).
 *
 * Reported symptom: the matrix still painted a cell as **governed** because of a
 * business role that had been removed from the source. `Resources` is a
 * soft-delete table and resources reconcile independently of assignments, so a
 * role can be tombstoned while its membership row is still live — and both
 * governance-coverage derivations (`vw_UserPermissionAssignmentViaBusinessRole`
 * and the `soll` CTE behind `managedByAccessPackage`) filtered only the
 * assignment's `deletedAt`, never the role's. Every resource the dead role
 * `Contains` kept the business-role colour, kept being listed by the Governed
 * view, and kept counting toward the governed share in the scope statistics.
 *
 * This spec walks the reporter's path against the running stack, and seeds the
 * state it needs, because the demo dataset deliberately contains no tombstoned
 * business role (`test/demo-dataset/Verify-DemoDataset.ps1` asserts its absence):
 *
 *   1. register an ingest connector and a system of its own;
 *   2. full-sync two business roles, each `Contains`-ing a group of its own, and
 *      give one user all four as live assignments;
 *   3. open the matrix scoped to that user and those two groups: BOTH cells read
 *      as governed (the control — the grid can say it, so saying less later means
 *      something);
 *   4. full-sync the resources again with one role missing — what a source does
 *      when the role is deleted there. The role is tombstoned; its membership row
 *      stays live, which is the whole bug;
 *   5. the matrix now paints only the surviving role's cell governed: the dead
 *      role's group cell is an ordinary ungoverned Direct membership, the
 *      Governed lens lists only the live role's group, and the scope statistics
 *      count one governed assignment instead of two.
 *
 * Everything the spec seeds lives in its own system under fixed ids, so a re-run
 * revives the same rows (a full sync clears `deletedAt`) instead of accumulating
 * new ones, and the cleanup tombstones them again.
 *
 * Serial: every test reads the same seeded fixture, and step 4 changes the state
 * step 3 asserts on.
 */

import { test, expect } from '@playwright/test';
import { BASE, API, openIngestSession, closeIngestSession } from './ingestSeed.js';

test.describe.configure({ mode: 'serial' });

// The fixture's own system, keyed on (systemType, tenantId) — the ingest key for
// a system — so every run upserts this one row instead of registering another.
const SYSTEM = { displayName: 'E2E — deleted-business-role fixture', systemType: 'e2e', tenantId: 'e2e-1629' };

// Fixed ids and stable display names: the matrix is scoped by display name, and a
// replay has to find the same rows. No '#' in the names — the whole filter travels
// in the URL hash, where a literal fragment marker has no business.
const USER = {
  id: '1629e2e0-0000-4000-8000-000000000001',
  displayName: 'Rowan Verhaege2e1629',
  email: 'rowan.verhaege2e1629@e2e.invalid',
};
// The role the source deletes in step 4, and the live group it grants.
const ROLE_GONE  = { id: '1629e2e0-0000-4000-8000-000000000002', displayName: 'E2E 1629 role removed in source' };
const GROUP_GONE = { id: '1629e2e0-0000-4000-8000-000000000003', displayName: 'E2E 1629 group of the removed role' };
// The control pair: a role that stays live, and its group.
const ROLE_LIVE  = { id: '1629e2e0-0000-4000-8000-000000000004', displayName: 'E2E 1629 role still in source' };
const GROUP_LIVE = { id: '1629e2e0-0000-4000-8000-000000000005', displayName: 'E2E 1629 group of the live role' };

const ALL_RESOURCES = [ROLE_GONE, GROUP_GONE, ROLE_LIVE, GROUP_LIVE];

// What the user holds: both roles as governed memberships (how a business-role
// assignment is recorded), both groups as the plain Direct grants a provisioning
// run made. The same list names the rows again on the way out — an assignment row
// is identified by exactly these four columns.
const ASSIGNMENTS = [
  { resourceId: ROLE_GONE.id, principalId: USER.id, assignmentType: 'Direct', governed: true },
  { resourceId: ROLE_LIVE.id, principalId: USER.id, assignmentType: 'Direct', governed: true },
  { resourceId: GROUP_GONE.id, principalId: USER.id, assignmentType: 'Direct', governed: false },
  { resourceId: GROUP_LIVE.id, principalId: USER.id, assignmentType: 'Direct', governed: false },
];

// The matrix the reporter looks at: one subject, the two group rows. Business
// roles are off the resource axis by default (#937), so the governed signal on
// these two group cells is the whole question.
const FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'displayName', values: [USER.displayName] }], exclude: [] },
  resource: {
    include: [{ kind: 'attribute', field: 'displayName', values: [GROUP_GONE.displayName, GROUP_LIVE.displayName] }],
    exclude: [],
  },
  // The scope panel (with its governed / non-governed split) only mounts for a
  // filter that asks for it (#1202); it is view state, so the API ignores it.
  showTrends: true,
};

const matrixUrl = (managed) =>
  `${BASE}/#matrix?${new URLSearchParams({ filter: JSON.stringify(FILTER), ...(managed ? { managed } : {}) })}`;

/** @type {any} */
let session = null;
/** Why the fixture could not be set up, if it could not — each test skips on it. */
let unavailable = null;

const resourceRecord = (r, resourceType, governanceResource) => ({
  id: r.id,
  displayName: r.displayName,
  resourceType,
  governanceResource,
});

/** A full resources sync carrying exactly `resources`; anything else of this system is tombstoned. */
function syncResources(resources) {
  return session.mustIngest('resources', {
    syncMode: 'full',
    records: resources.map(r => (
      r === ROLE_GONE || r === ROLE_LIVE
        ? resourceRecord(r, 'BusinessRole', true)
        : resourceRecord(r, 'Group', false)
    )),
  });
}

test.beforeAll(async () => {
  session = await openIngestSession({
    displayName: 'e2e-1629',
    description: 'Throwaway key for the #1629 deleted-business-role E2E. Removed by the spec.',
    system: SYSTEM,
    // The spec reads matviews it has just written, so it must be able to rebuild them.
    permissions: ['ingest', 'refreshViews'],
  });
  if (!session.ok) {
    unavailable = session.reason;
    return;
  }
  try {
    await session.mustIngest('principals', {
      syncMode: 'full',
      records: [{ ...USER, principalType: 'User', accountEnabled: true }],
    });
    await syncResources(ALL_RESOURCES);
    await session.mustIngest('resource-relationships', {
      syncMode: 'full',
      records: [
        { parentResourceId: ROLE_GONE.id, childResourceId: GROUP_GONE.id, relationshipType: 'Contains', roleName: 'Member' },
        { parentResourceId: ROLE_LIVE.id, childResourceId: GROUP_LIVE.id, relationshipType: 'Contains', roleName: 'Member' },
      ],
    });
    // The role memberships are governed; the group memberships are the ordinary
    // Direct grants a provisioning run made — exactly the production shape.
    await session.mustIngest('resource-assignments', { syncMode: 'full', records: ASSIGNMENTS });
    await session.refreshViews();
  } catch (err) {
    unavailable = `could not seed the #1629 fixture: ${err.message}`;
  }
});

test.afterAll(async () => {
  // The memberships first — an assignment row is named by its composite key, and
  // leaving the governed ones live would leave the deployment with a business-role
  // membership nobody holds. Then the rows themselves (tombstoned: both tables
  // soft-delete), the system and the key.
  if (session?.ok) {
    await session.ingest('resource-assignments', { deletedKeys: ASSIGNMENTS }).catch(() => {});
  }
  await closeIngestSession(session, {
    principalIds: [USER.id],
    resourceIds: ALL_RESOURCES.map(r => r.id),
    systemNote: 'Disabled leftover of the #1629 deleted-business-role E2E.',
  });
});

/** One of the matrix endpoints the page itself posts to, for the fixture's matrix. */
async function matrixPost(path) {
  const res = await fetch(`${API}/matrix/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: FILTER }),
  });
  expect(res.ok, `POST /matrix/${path} returned ${res.status}`).toBeTruthy();
  return res.json();
}

/** The grid's own request — rows plus the business-role coverage sidecar. */
const matrixData = () => matrixPost('data');
/** What the scope panel's governed split is computed from. */
const scopeStats = () => matrixPost('scope-stats');

/** Ids come back in whatever case the source wrote them; compare them as ids. */
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** The business roles the coverage view names for one (subject, resource) cell. */
const coveringRoles = (body, resourceId) =>
  (body.managedByPackages || [])
    .filter(m => eq(m.memberId, USER.id) && eq(m.resourceId, resourceId))
    .flatMap(m => m.accessPackageIds);

/** The grid row whose name cell carries `displayName`. */
function gridRow(page, displayName) {
  return page.locator('tbody tr').filter({ hasText: displayName }).first();
}

/**
 * The membership cell in that row — the one cell carrying a D/I/E tooltip. Its
 * `title` is the governed signal the reporter sees: a governed cell says what
 * manages it, an ungoverned one says only how the access is held.
 */
async function cellTooltip(page, displayName) {
  const row = gridRow(page, displayName);
  await expect(row).toBeVisible({ timeout: 60000 });
  const cell = row.locator('td[title^="Direct"]').first();
  await expect(cell).toBeVisible({ timeout: 30000 });
  return (await cell.getAttribute('title')) || '';
}

/**
 * Does this cell claim to be governed? Both wordings count — the grid names the
 * covering role(s) when it has them and falls back to "managed by business role".
 */
const claimsGoverned = (title) => /Managed by:|managed by business role/.test(title);

/**
 * Does it name this role? By display name when the role is one of the matrix's
 * business-role columns, by bare id when it is not (`MatrixGroupRow` falls back
 * to the id), so the assertion holds on an empty tenant and a populated one.
 */
const namesRole = (title, role) =>
  title.includes(role.displayName) || title.toLowerCase().includes(role.id);

test.describe('#1629 — the matrix before the role is deleted (control)', () => {
  test.setTimeout(180000);

  test('both roles govern their group, in the view and on the grid', async ({ page }) => {
    test.skip(!!unavailable, unavailable || '');

    const body = await matrixData();
    expect(coveringRoles(body, GROUP_GONE.id).map(id => id.toLowerCase()))
      .toEqual([ROLE_GONE.id]);
    expect(coveringRoles(body, GROUP_LIVE.id).map(id => id.toLowerCase()))
      .toEqual([ROLE_LIVE.id]);

    const stats = await scopeStats();
    expect(stats.assignmentCount).toBe(2);
    expect(stats.governedAssignmentCount).toBe(2);

    await page.goto(matrixUrl());
    const gone = await cellTooltip(page, GROUP_GONE.displayName);
    expect(claimsGoverned(gone), gone).toBe(true);
    expect(namesRole(gone, ROLE_GONE), gone).toBe(true);
    const live = await cellTooltip(page, GROUP_LIVE.displayName);
    expect(claimsGoverned(live), live).toBe(true);
    expect(namesRole(live, ROLE_LIVE), live).toBe(true);
  });
});

test.describe('#1629 — after the source deletes the role', () => {
  test.setTimeout(180000);

  // Step 4: the source no longer has ROLE_GONE. Its membership row is untouched
  // and stays live — resources and assignments reconcile separately.
  test.beforeAll(async () => {
    if (unavailable) return;
    try {
      await syncResources(ALL_RESOURCES.filter(r => r !== ROLE_GONE));
      await session.refreshViews();
      const gone = await fetch(`${API}/resources/${ROLE_GONE.id}`).then(r => (r.ok ? r.json() : null));
      if (!gone?.attributes?.deletedAt) unavailable = 'the full sync did not tombstone the business role';
    } catch (err) {
      unavailable = `could not tombstone the business role: ${err.message}`;
    }
  });

  test('the deleted role no longer covers its group, and the live one still does', async () => {
    test.skip(!!unavailable, unavailable || '');

    const body = await matrixData();
    expect(coveringRoles(body, GROUP_GONE.id)).toEqual([]);
    // Not vacuous: the surviving role's coverage is untouched.
    expect(coveringRoles(body, GROUP_LIVE.id).map(id => id.toLowerCase()))
      .toEqual([ROLE_LIVE.id]);
    // The membership itself is still there — only the claimed governance is gone.
    const cells = (body.data || []).filter(d => eq(d.memberId, USER.id) && eq(d.resourceId, GROUP_GONE.id));
    expect(cells).toHaveLength(1);
    expect(cells[0].managedByAccessPackage).toBe(false);
  });

  test('the scope statistics count one governed assignment, not two', async () => {
    test.skip(!!unavailable, unavailable || '');

    const stats = await scopeStats();
    expect(stats.assignmentCount).toBe(2);
    expect(stats.governedAssignmentCount).toBe(1);
    expect(stats.ungovernedAssignmentCount).toBe(1);
    expect(stats.governedPct).toBe(50);
  });

  test('the grid paints the cell ungoverned and the scope panel agrees', async ({ page }) => {
    test.skip(!!unavailable, unavailable || '');

    await page.goto(matrixUrl());
    // The reporter's cell: still a Direct membership, no longer managed by anything.
    const gone = await cellTooltip(page, GROUP_GONE.displayName);
    expect(claimsGoverned(gone), gone).toBe(false);
    expect(namesRole(gone, ROLE_GONE), gone).toBe(false);
    // The control cell still names its live role, so the grid can still say it.
    const live = await cellTooltip(page, GROUP_LIVE.displayName);
    expect(claimsGoverned(live), live).toBe(true);
    expect(namesRole(live, ROLE_LIVE), live).toBe(true);

    // The scope panel's governed split, as it is read on screen.
    await expect(page.getByText('1 governed', { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('1 non-governed', { exact: true })).toBeVisible();
  });

  test('the Governed view lists only the live role’s group', async ({ page }) => {
    test.skip(!!unavailable, unavailable || '');

    await page.goto(matrixUrl('managed'));
    await expect(gridRow(page, GROUP_LIVE.displayName)).toBeVisible({ timeout: 60000 });
    await expect(gridRow(page, GROUP_GONE.displayName)).toHaveCount(0);

    // And the Non-governed view — the role-mining backlog — has it back. Switched
    // with the toolbar lens, as the reporter would: a second `goto` that changes
    // only the hash does not reload the page, and the lens is read from the hash
    // once, on mount — so the grid would still be showing the Governed view.
    await page.getByRole('button', { name: 'Non-governed', exact: true }).click();
    await expect(gridRow(page, GROUP_GONE.displayName)).toBeVisible({ timeout: 60000 });
    await expect(gridRow(page, GROUP_LIVE.displayName)).toHaveCount(0);
  });
});
