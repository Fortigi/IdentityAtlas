// @ts-check
//
// An admin account's login carries its owner's name — `adm-fhogenbirk` says "the
// F. Hogenbirk of this tenant" — and the shipped dictionary used to read it as an
// address only: strip `adm-`, then demand the rest equal the owner's email local
// part exactly. Where the personal mailbox is `f.h.hogenbirk` (two initials) and
// the admin login carries `fhogenbirk` (one), nothing fired, and the account
// linked only if its display name happened to spell the person's name. The
// reporter measured 30 of 64 admin accounts linked, every one of them on its
// display name, none on its login (#1454).
//
// This spec walks the reporter's own path against the live deployment:
//
//   1. Admin → Account Linking → Run now,
//   2. Identities → the person's detail page → Linked Accounts: the
//      `adm-<initial><surname>` account is THERE, which is the regression,
//   3. the Orphaned Accounts report no longer lists it,
//   4. the paired safety case: `adm-p<surname>` fits two people, so it links to
//      neither and is held for review with its rival named,
//   5. a second run detaches nothing — a link made on a login converges instead
//      of being detached and re-created on every run.
//
// (2), (3) and (5) are the assertions a unit test cannot make: they read the
// stored links back through the identities API and the report, and (5) runs the
// engine twice against one database. The retroactive cleanup judges name-only
// links, and a login is name-class evidence, so a cleanup that cannot see the
// account's login detaches exactly the links this fix creates — green in every
// mocked test, visible only here.
//
// Seeded through the ingest API under a system of its own with a per-run name
// token: the demo dataset builds every admin login as `adm-` + the owner's exact
// local part and pre-links them, so the symptom is not in it by construction
// (the second convention is #1465).
//
// The run is a real POST, so this spec changes deployment state — it links
// accounts the same way the post-crawl auto-run does. That is deliberate: a
// dry-run would not prove the writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, openIngestSession, closeIngestSession, linkingRules, runAccountLinkingFromAdmin,
  latestCompletedRun, linkedAccountNames, linkedPrincipalIds, linkedAccountsPanel, orphanReport,
} from './accountLinkingSeed';

const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const DOMAIN = 'e2e-1454.example';

// Two single-token surnames, so the name parser cannot read a particle as the
// surname and change what is being asked here.
//
//   SOLE  one person, whose mailbox uses TWO initials while her admin login
//         carries one. Her admin account must land on her — the regression.
//   TWIN  two people whose given names share an initial, so one admin login fits
//         both. It must stay held, with the other named as its rival.
const SOLE = `Hogenbirkz${TOKEN}`;
const TWIN = `Munckz${TOKEN}`;

const IDS = {
  fay: randomUUID(), petra: randomUUID(), pieter: randomUUID(),
  admFay: randomUUID(), admMunck: randomUUID(),
};

const NAMES = {
  fay: `Fay ${SOLE}`,
  petra: `Petra ${TWIN}`,
  pieter: `Pieter ${TWIN}`,
  admFay: `Admin account ${TOKEN}-1`,
  admMunck: `Admin account ${TOKEN}-2`,
};

/**
 * An HR person whose address spells her whole name, in whatever convention the
 * `local` argument states — the point of the fixture is that it is NOT the
 * convention her admin login uses.
 */
const person = (id, displayName, local) => {
  const [given, surname] = displayName.split(' ');
  return {
    id, displayName, givenName: given, surname,
    email: `${local}@${DOMAIN}`.toLowerCase(),
    employeeId: `E2E1454-${id.slice(0, 8)}`,
    companyName: 'E2E #1454',
  };
};

/**
 * An admin account whose display name carries no person's name at all and which
 * holds no employee id — so its login is the only evidence there is, like the 9
 * unlinked directory accounts in the report. An `employeeId` here would link it
 * at weight 95 and never exercise this path.
 */
const adminAccount = (id, displayName, local) => ({
  id, displayName, email: `${local}@${DOMAIN}`.toLowerCase(),
  principalType: 'User', accountEnabled: true,
});

const IDENTITIES = [
  person(IDS.fay, NAMES.fay, `f.h.${SOLE}`),
  person(IDS.petra, NAMES.petra, `petra.${TWIN}`),
  person(IDS.pieter, NAMES.pieter, `pieter.${TWIN}`),
];
const ACCOUNTS = [
  // `adm-` + first initial + surname: her mailbox has two initials, so this
  // matches her address under no amount of separator stripping.
  adminAccount(IDS.admFay, NAMES.admFay, `adm-f${SOLE}`),
  // The same form, for a surname two people share an initial on.
  adminAccount(IDS.admMunck, NAMES.admMunck, `adm-p${TWIN}`),
];

let rules;
let seeded = null;
let firstRun = null;

test.beforeAll(async () => {
  rules = await linkingRules();
  test.skip(!rules, 'account-linking config endpoint not available to this user');

  seeded = await openIngestSession({
    displayName: `e2e-1454-${TOKEN}`,
    description: 'Throwaway key for the #1454 account-linking E2E. Removed by the spec.',
    system: { systemType: 'HR', tenantId: `e2e-1454-${TOKEN}`, displayName: `E2E #1454 HR (${TOKEN})` },
  });
  if (seeded.ok) {
    await seeded.mustIngest('identities', { records: IDENTITIES });
    await seeded.mustIngest('principals', { records: ACCOUNTS });
  }
});

test.afterAll(async () => {
  if (seeded?.systemId) {
    // Off every human-facing surface on the way out: a tombstoned account is no
    // longer an orphan, but the rows outlive the retention window.
    await seeded.ingest('principals', { deletedIds: ACCOUNTS.map(a => a.id) }).catch(() => {});
  }
  await closeIngestSession(seeded, {
    identityIds: IDENTITIES.map(i => i.id),
    systemNote: 'Disabled leftover of the #1454 account-linking E2E.',
  });
});

test.describe('Account linking — an admin login carrying initial + surname (#1454)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(!seeded?.ok, 'could not seed through the ingest API (SQL mode required)');
    // The fixture rests on the login alone. A deployment that raised the certainty
    // slider past the login signal's weight, or that stopped linking Admin
    // accounts, would hold both accounts for reasons that are not this bug.
    const loginWeight = (rules?.signals || []).find(s => s.type === 'loginName')?.weight ?? 0;
    test.skip(
      !(rules?.onlyLinkTypes || []).includes('Admin') || (rules?.linkThreshold ?? 0) > loginWeight,
      'the deployment\'s linking rules would not link on a login alone',
    );
  });

  test('the dictionary reads a login as a name, graded below a full-name match', async () => {
    // The ratified shape of the fix, read off the tenant's own active rules: the
    // signal exists, it strips the admin prefixes, and it is never near-certain
    // evidence — this engine decides whose access review, risk score and leaver
    // handling an admin account inherits.
    const login = (rules.signals || []).find(s => s.type === 'loginName');
    expect(login, 'the active dictionary has no login-reading signal').toBeTruthy();
    expect(login.stripPrefixes).toContain('adm-');
    const fullNameWeight = (rules.signals || []).find(s => s.name === 'fullName')?.weight ?? 0;
    expect(login.weight).toBeLessThan(fullNameWeight);
    expect(login.weight).toBeGreaterThanOrEqual(rules.linkThreshold ?? 50);
  });

  test('the admin account lands on the person its login singles out, through the UI', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);
    firstRun = await latestCompletedRun();

    // The regression: nobody else in this tenant is an F. Hogenbirkz…, so this
    // account is hers — even though her own mailbox spells her name differently.
    expect(await linkedPrincipalIds(IDS.fay)).toContain(IDS.admFay);

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.fay}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: NAMES.admFay, exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('and it is no longer in the Orphaned Accounts report', async () => {
    // The other half of the reported symptom: the account stayed outstanding
    // analyst work. A link that does not clear it off this report has not
    // actually placed the account.
    const names = (await orphanReport()).rows.map(r => r.displayName);
    expect(names).not.toContain(NAMES.admFay);
    // The control — the ambiguous one is genuinely still there, so a report that
    // broke entirely cannot read as a pass.
    expect(names).toContain(NAMES.admMunck);
  });

  test('an admin login two people answer to links to neither, and names its rival', async () => {
    // The paired case, and what stops the fix reducing to "whoever matches best
    // wins": initial + surname drops every given name but its first letter, so
    // `adm-p<surname>` fits Petra and Pieter equally and the wrong one would
    // inherit the other's access review, risk score and leaver handling.
    expect(await linkedAccountNames(IDS.petra)).toEqual([]);
    expect(await linkedAccountNames(IDS.pieter)).toEqual([]);

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.admMunck);
    expect(held, `the run did not report the held match for ${NAMES.admMunck} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('loginName');
    expect(held.rivalCount).toBe(1);
    expect(held.rivals.map(r => r.identityName)).toEqual([
      held.identityId === IDS.petra ? NAMES.pieter : NAMES.petra,
    ]);
  });

  test('a second run detaches nothing and leaves the account where it was put', async ({ page }) => {
    // Convergence, and the half only a live database can show. The run's
    // retroactive cleanup judges every name-only link, and a login is name-class
    // evidence — so a cleanup that cannot read the account's login sees a link
    // resting on a name that points at nobody, detaches it, re-creates it from
    // the orphan pool in the same run, and churns the account's history forever.
    await runAccountLinkingFromAdmin(page);
    const second = await latestCompletedRun();

    expect(second.status).toBe('completed');
    expect(second.linksRemoved, 'the second run re-detached links the first one settled').toBe(0);
    expect(await linkedPrincipalIds(IDS.fay)).toContain(IDS.admFay);
    expect(second.nameOnlyMatches).toBe(firstRun?.nameOnlyMatches);
  });
});
