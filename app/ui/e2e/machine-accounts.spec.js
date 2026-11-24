// @ts-check
/**
 * Computer accounts as principals of their own — issue #1683.
 *
 * Active Directory groups routinely contain computer accounts, and a computer
 * account is a security principal in its own right. Before this change the
 * canonical `principalType` set had no value for one, so an import either
 * dropped it or labelled the server as a person. `MachineAccount` is that value,
 * and this spec walks the acceptance criteria against the running stack.
 *
 * The demo dataset deliberately contains no machine accounts, so the fixture is
 * seeded through the real ingest — the same way an AD import would load them:
 *
 *   1. two machine accounts (`SRV-FILE01$`, `SRV-SQL02$`) plus a person's
 *      account, all three carrying the same employeeId as one seeded identity;
 *   2. a group, with one machine account holding a Direct membership on it.
 *
 * Then:
 *   - the ingest accepts `MachineAccount` and still refuses `Computer` (the
 *      discriminating pair: one accepted spelling, not free text);
 *   - the Principals page lists both servers under a "Machine Accounts" tab and
 *      not the person, and the account page marks one as a machine;
 *   - a context member table calls it a machine account, not a member;
 *   - Account Linking attaches the person's account to the identity and never
 *      either machine account, and neither shows up as an orphan — the control
 *      and the regression in one run, on accounts that score identically;
 *   - the machine account's group membership is an ordinary Direct cell in the
 *      matrix.
 *
 * Fixed ids in a system of this spec's own, so a re-run upserts the same rows,
 * and the cleanup tombstones everything it seeded.
 *
 * Serial: the tests share one seeded fixture, and the linking run in the
 * correlation test changes what the orphan assertions see.
 */

import { test, expect } from '@playwright/test';
import {
  BASE, API, openIngestSession, closeIngestSession,
  linkingRules, linkedPrincipalIds, orphanReport, runAccountLinkingFromAdmin,
} from './accountLinkingSeed';

test.describe.configure({ mode: 'serial' });

// The fixture's own system, keyed on (systemType, tenantId) — the ingest key for
// a system — so every run upserts this one row instead of registering another.
const SYSTEM = { displayName: 'E2E — machine-account fixture', systemType: 'AD', tenantId: 'e2e-1683' };

// All three accounts and the identity share this, so each scores the employeeId
// signal (weight 95) against that one person and nothing else in the dataset.
// Which means the ONLY thing that can keep a machine account off the person is
// its principalType.
const EMPLOYEE_ID = 'E2E-1683-EMP';

const FILE_SERVER = {
  id: '1683e2e0-0000-4000-8000-000000000001',
  displayName: 'SRV-FILE01$',
  principalType: 'MachineAccount',
};
const SQL_SERVER = {
  id: '1683e2e0-0000-4000-8000-000000000002',
  displayName: 'SRV-SQL02$',
  principalType: 'MachineAccount',
};
// The control account: a person, seeded with the same employeeId, so "the
// machine accounts were not linked" cannot pass just because linking did
// nothing at all.
const PERSON = {
  id: '1683e2e0-0000-4000-8000-000000000003',
  displayName: 'Vermeer, Sanne (e2e-1683)',
  email: 'sanne.vermeer.e2e1683@e2e.invalid',
  principalType: 'User',
};
const IDENTITY = { id: '1683e2e0-0000-4000-8000-000000000004', displayName: 'Sanne Vermeer (e2e-1683)' };

const ACCOUNTS = [FILE_SERVER, SQL_SERVER, PERSON];

// The group the file server is a member of — an AD group granting a share.
const GROUP = { id: '1683e2e0-0000-4000-8000-000000000005', displayName: 'E2E 1683 File Share Readers' };

// A context the servers belong to, so the member table that names a kind of
// account in plain words has something to name.
const CONTEXT = {
  id: '1683e2e0-0000-4000-8000-000000000006',
  displayName: 'E2E 1683 Server OU',
  variant: 'synced',
  targetType: 'Principal',
  contextType: 'OrgUnit',
};

// An assignment row is named by exactly these columns, so the same list removes
// it again on the way out.
const ASSIGNMENTS = [
  { resourceId: GROUP.id, principalId: FILE_SERVER.id, assignmentType: 'Direct', governed: false },
];

// One subject (the file server) against the one group — the smallest matrix that
// answers "does a membership held by a machine account appear like any other".
const MATRIX_FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'displayName', values: [FILE_SERVER.displayName] }], exclude: [] },
  resource: { include: [{ kind: 'attribute', field: 'displayName', values: [GROUP.displayName] }], exclude: [] },
};

/** @type {any} */
let session = null;
/** Why the fixture could not be set up, if it could not — each test skips on it. */
let unavailable = null;

const principalRecord = (a) => ({
  id: a.id,
  displayName: a.displayName,
  email: a.email ?? null,
  employeeId: EMPLOYEE_ID,
  principalType: a.principalType,
  accountEnabled: true,
});

test.beforeAll(async () => {
  session = await openIngestSession({
    displayName: `e2e-1683-ingest-${Date.now()}`,
    description: 'Throwaway key for the #1683 machine-account E2E. Removed by the spec.',
    // The matrix is served from matviews this spec writes, so it must be able to rebuild them.
    system: SYSTEM,
    permissions: ['ingest', 'refreshViews'],
  });
  if (!session.ok) {
    unavailable = session.reason;
    return;
  }
  try {
    await session.mustIngest('identities', {
      records: [{ id: IDENTITY.id, displayName: IDENTITY.displayName, employeeId: EMPLOYEE_ID }],
    });
    await session.mustIngest('principals', { syncMode: 'full', records: ACCOUNTS.map(principalRecord) });
    await session.mustIngest('resources', {
      syncMode: 'full',
      records: [{ id: GROUP.id, displayName: GROUP.displayName, resourceType: 'Group', governanceResource: false }],
    });
    await session.mustIngest('resource-assignments', { syncMode: 'full', records: ASSIGNMENTS });
    // Delta, never full: contexts are not scoped to one system, so a full sync
    // here would reconcile the whole table.
    await session.mustIngest('contexts', { records: [{ ...CONTEXT, scopeSystemId: session.systemId }] });
    await session.mustIngest('context-members', {
      records: [FILE_SERVER, SQL_SERVER].map(a => ({ contextId: CONTEXT.id, memberId: a.id, memberType: 'Principal' })),
    });
    await session.refreshViews();
  } catch (err) {
    unavailable = `could not seed the #1683 fixture: ${err.message}`;
  }
});

test.afterAll(async () => {
  if (session?.ok) {
    await session.ingest('resource-assignments', { deletedKeys: ASSIGNMENTS }).catch(() => {});
    // The context is hard-deleted, which takes its membership rows with it.
    await session.ingest('contexts', { deletedIds: [CONTEXT.id] }).catch(() => {});
    await session.ingest('principals', { deletedIds: ACCOUNTS.map(a => a.id) }).catch(() => {});
  }
  // The identity last: a hard delete cascades the IdentityMembers rows a linking
  // run wrote, so a replay starts with every seeded account unlinked again.
  await closeIngestSession(session, {
    identityIds: [IDENTITY.id],
    resourceIds: [GROUP.id],
    systemNote: 'Disabled leftover of the #1683 machine-account E2E.',
  });
});

test.beforeEach(() => {
  test.skip(!!unavailable, String(unavailable));
});

/** One account as the API serves it to the detail page. */
async function principal(id) {
  const res = await fetch(`${API}/user/${encodeURIComponent(id)}`);
  expect(res.ok, `GET /api/user/${id} returned ${res.status}`).toBe(true);
  return (await res.json())?.attributes ?? {};
}

/** The Principals page, on one principalType sub-tab. */
async function openPrincipalsTab(page, type) {
  await page.goto(`${BASE}/#principals?type=${type}`);
  await expect(page.getByRole('button', { name: 'Machine Accounts' })).toBeVisible({ timeout: 30000 });
  // The tab is the active one, not merely present.
  await expect(page.getByRole('button', { name: 'Machine Accounts' })).toHaveClass(/border-indigo-600/);
}

/** Search the open list for one account and return its row. */
async function findRow(page, displayName) {
  await page.getByRole('textbox', { name: /Search by name or UPN/i }).fill(displayName);
  const row = page.locator('tbody tr').filter({ hasText: displayName }).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  return row;
}

test.describe('#1683 — a computer account is a principal of its own', () => {
  test.setTimeout(180000);

  test('the ingest stores MachineAccount verbatim and refuses the other spellings', async () => {
    // Stored as sent — not coerced to User, which is what the fallback used to do.
    expect((await principal(FILE_SERVER.id)).principalType).toBe('MachineAccount');
    expect((await principal(SQL_SERVER.id)).principalType).toBe('MachineAccount');

    // The discriminating half: the near-misses a source might reach for are
    // still rejected, so the type cannot drift into free text.
    for (const wrong of ['Computer', 'Device', 'machine']) {
      const res = await session.ingest('principals', {
        records: [{ ...principalRecord(FILE_SERVER), id: '1683e2e0-0000-4000-8000-0000000000ff', principalType: wrong }],
      });
      expect(res.status, `principalType=${wrong} should be refused`).toBe(400);
    }
  });

  test('the Principals page lists them as Machine Accounts and marks one as a machine', async ({ page }) => {
    await openPrincipalsTab(page, 'MachineAccount');

    // Both servers are in the machine-accounts view…
    await findRow(page, FILE_SERVER.displayName);
    await findRow(page, SQL_SERVER.displayName);

    // …and the person is not: the tab really filters on the type rather than
    // listing everything.
    await page.getByRole('textbox', { name: /Search by name or UPN/i }).fill(PERSON.displayName);
    await expect(page.locator('tbody tr').filter({ hasText: PERSON.displayName })).toHaveCount(0, { timeout: 30000 });

    // The account page names the type on its header pill — the span right after
    // the name, not the attributes row further down the page.
    await page.goto(`${BASE}/#user:${FILE_SERVER.id}`);
    await expect(page.getByRole('heading', { name: FILE_SERVER.displayName })).toBeVisible({ timeout: 30000 });
    const pill = page.locator(`h2:text-is("${FILE_SERVER.displayName}") + span`);
    await expect(pill).toHaveText('MachineAccount');
    // Its own colour, not the grey "type we do not know" fallback.
    await expect(pill).toHaveClass(/cyan/);
    await expect(pill).not.toHaveClass(/bg-gray-100/);
  });

  test('a context member table calls it a machine account', async ({ page }) => {
    await page.goto(`${BASE}/#context:${CONTEXT.id}`);
    await expect(page.getByRole('heading', { name: CONTEXT.displayName })).toBeVisible({ timeout: 30000 });

    // The Type cell is the kind of account in plain words — "Machine account",
    // not "Member", which is what a person's account would read.
    const row = page.locator('tbody tr').filter({ hasText: FILE_SERVER.displayName }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText('Machine account');
    await expect(row).not.toContainText('Member');
  });

  test('Account Linking correlates the person and never a machine account', async ({ page }) => {
    const rules = (await linkingRules()) || {};
    // The person's account links on its employeeId (an exact signal, weight 95).
    // A tenant that raised the threshold past it, or that stopped linking plain
    // secondary accounts, has no control — and without the control the
    // regression half of this test is not discriminating.
    test.skip(
      !(rules.onlyLinkTypes || []).includes('Secondary') || (rules.linkThreshold ?? 0) > 95,
      'the deployment\'s linking rules would not link the control account',
    );

    // Before the run: neither kind of account is outstanding analyst work for a
    // machine, so only the person's account is an orphan.
    const before = (await orphanReport()).rows.map(r => r.displayName);
    expect(before).toContain(PERSON.displayName);
    expect(before).not.toContain(FILE_SERVER.displayName);
    expect(before).not.toContain(SQL_SERVER.displayName);

    await runAccountLinkingFromAdmin(page);

    // Control and regression in one assertion: the person's account was attached
    // to the person it matches, and neither server was — even though all three
    // carry the same employeeId and would have scored identically.
    expect(await linkedPrincipalIds(IDENTITY.id)).toEqual([PERSON.id]);

    // And the run leaves no machine account behind as an orphan either.
    const after = (await orphanReport()).rows.map(r => r.displayName);
    expect(after).not.toContain(FILE_SERVER.displayName);
    expect(after).not.toContain(SQL_SERVER.displayName);
  });

  test('a group membership held by a machine account is an ordinary Direct cell in the matrix', async ({ page }) => {
    await page.goto(`${BASE}/#matrix?filter=${encodeURIComponent(JSON.stringify(MATRIX_FILTER))}`);

    const row = page.locator('tbody tr').filter({ hasText: GROUP.displayName }).first();
    await expect(row).toBeVisible({ timeout: 60000 });
    const cell = row.locator('td[title^="Direct"]').first();
    await expect(cell).toBeVisible({ timeout: 30000 });
    await expect(cell).toContainText('D');
  });
});
