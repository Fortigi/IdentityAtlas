// @ts-check
//
// A link made on the name alone survives the account being removed (#1461).
//
// Reported symptom: an identity quietly lost a linked account — and with it the trail to
// every grant on that account — after a full sync removed the account and a second person
// of the same name appeared. The name-only cleanup #1450 introduced re-judged the link,
// found the name now points at two people, and detached it. A removed account is not in
// the orphan pool (#1442), so nothing re-linked it and nothing held it for review: the run
// simply counted it in `linksRemoved` and the account was gone from the identity.
//
// This walks the reporter's path against the running stack, seeding the state because the
// demo dataset deliberately contains no member rows on removed accounts:
//
//   1. seed a person and a secondary account spelled exactly her name, with no employee id
//      and an unrelated address — so the name is the only evidence there is;
//   2. Admin → Account Linking → Run now: the account links to her on `fullName` alone.
//      The control — without it the later assertion would also pass for a link that was
//      never made;
//   3. a full sync removes the account (ingest stamps `deletedAt`), and a namesake joins
//      the directory, so the name no longer points at one person;
//   4. run again, and read the identity's Linked Accounts the way the reporter did: the
//      account is still there, and the run did not count it in `linksRemoved`.
//
// The paired case is what stops the fix reducing to "the cleanup never removes anything":
// a *live* account in the same position must still be detached and held for review, which
// is what #1450 exists to do. Both are driven through one run, so a fix that over-filtered
// fails here.
//
// Serial, and it changes deployment state: the runs are real and write links, the same way
// the post-crawl auto-run does. A dry-run would not prove the writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, openIngestSession, closeIngestSession, linkingRules, runAccountLinkingFromAdmin,
  identityMembers, linkedPrincipalIds, linkedAccountsPanel, latestCompletedRun,
} from './accountLinkingSeed';

// Per-run name token: the whole fixture turns on how many people answer to a name, so it
// must not collide with the deployment's own population or with a previous replay's rows.
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const SURNAME = `Tenbergz${TOKEN}`;
const NAME = `Marit ${SURNAME}`;
const LIVE_SURNAME = `Okkersz${TOKEN}`;
const LIVE_NAME = `Sanne ${LIVE_SURNAME}`;

const IDS = {
  marit: randomUUID(),
  maritNamesake: randomUUID(),
  removedAccount: randomUUID(),
  sanne: randomUUID(),
  sanneNamesake: randomUUID(),
  liveAccount: randomUUID(),
};

/** An HR person: a name, an address of her own, and an employee id nothing else carries. */
const person = (id, displayName, local) => {
  const [given, surname] = displayName.split(' ');
  return {
    id, displayName, givenName: given, surname,
    email: `${local}@e2e-1461.example`,
    employeeId: `E2E1461-${id.slice(0, 8)}`,
    companyName: 'E2E #1461',
  };
};

/**
 * A directory account with no employee id and an address that matches nobody, so the name
 * signals are the only evidence — the condition a name-only link needs.
 */
const nameOnlyAccount = (id, displayName) => ({
  id, displayName, principalType: 'User', accountEnabled: true,
});

let seeded = null;
let rules = null;

test.beforeAll(async () => {
  rules = await linkingRules();
  seeded = await openIngestSession({
    displayName: `e2e-1461-${TOKEN}`,
    description: 'Throwaway key for the #1461 account-linking E2E. Removed by the spec.',
    system: { systemType: 'HR', tenantId: `e2e-1461-${TOKEN}`, displayName: `E2E #1461 HR (${TOKEN})` },
  });
  if (!seeded.ok) return;

  // Only the two people who exist before anything is linked. Their namesakes arrive
  // mid-test — that they appear *after* the link was made is the whole fixture.
  await seeded.mustIngest('identities', {
    records: [
      person(IDS.marit, NAME, `marit.${SURNAME}`.toLowerCase()),
      person(IDS.sanne, LIVE_NAME, `sanne.${LIVE_SURNAME}`.toLowerCase()),
    ],
  });
  await seeded.mustIngest('principals', {
    records: [
      nameOnlyAccount(IDS.removedAccount, NAME),
      nameOnlyAccount(IDS.liveAccount, LIVE_NAME),
    ],
  });
});

test.afterAll(async () => {
  if (seeded?.systemId) {
    await seeded.ingest('principals', {
      deletedIds: [IDS.removedAccount, IDS.liveAccount],
    }).catch(() => {});
  }
  await closeIngestSession(seeded, {
    identityIds: [IDS.marit, IDS.maritNamesake, IDS.sanne, IDS.sanneNamesake],
    systemNote: 'Disabled leftover of the #1461 account-linking E2E.',
  });
});

test.describe('Account linking — a removed account keeps the link it already had (#1461)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(!seeded?.ok, String(seeded?.reason || 'could not seed through the ingest API (SQL mode required)'));
    // Both halves rest on a name-only match at full-name strength. A deployment that raised
    // the certainty slider past that weight, or stopped linking plain secondary accounts,
    // would link neither — no control, and the regression half would pass for free.
    const nameWeight = (rules?.signals || []).find(s => s.name === 'fullName')?.weight ?? 0;
    test.skip(
      !(rules?.onlyLinkTypes || []).includes('Secondary') || (rules?.linkThreshold ?? 0) > nameWeight,
      'the deployment\'s linking rules would not link a name-only match',
    );
    test.skip(rules?.allowNameOnlyLinks === false,
      'this deployment holds back every name-only match, so no name-only link is ever made');
  });

  test('both accounts link on the name alone while the name points at one person', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);

    // The control. These are the links the cleanup is entitled to re-judge: scored by the
    // engine, untouched by an analyst, resting on `fullName` and nothing else.
    const [maritLink] = await identityMembers(IDS.marit);
    expect(maritLink?.principalId, `${NAME} should have linked on the name alone`).toBe(IDS.removedAccount);
    expect(maritLink?.linkSignals).toBe('fullName');
    expect(await linkedPrincipalIds(IDS.sanne)).toEqual([IDS.liveAccount]);
  });

  test('the account is removed by a sync and a namesake joins for each person', async () => {
    // A full sync that no longer carries Marit's account: the ingest tombstones it rather
    // than deleting the row, which is the state the whole issue is about. Sanne's account
    // rides along and stays live — the paired case.
    const sync = await seeded.ingest('principals', {
      syncMode: 'full',
      records: [nameOnlyAccount(IDS.liveAccount, LIVE_NAME)],
    });
    expect(sync.ok, 'the removal sync should be accepted').toBe(true);

    // Now a second person of each name appears, so neither name points at one person any
    // more — the condition that makes the cleanup judge both links stale.
    await seeded.mustIngest('identities', {
      records: [
        person(IDS.maritNamesake, NAME, `marit.${SURNAME}.2`.toLowerCase()),
        person(IDS.sanneNamesake, LIVE_NAME, `sanne.${LIVE_SURNAME}.2`.toLowerCase()),
      ],
    });

    // Nothing has run yet, so both links are still exactly where the first run left them.
    expect(await linkedPrincipalIds(IDS.marit)).toEqual([IDS.removedAccount]);
    expect(await linkedPrincipalIds(IDS.sanne)).toEqual([IDS.liveAccount]);
  });

  test('a run keeps the removed account linked and still detaches the live one', async ({ page }) => {
    const before = await identityMembers(IDS.marit);

    await runAccountLinkingFromAdmin(page);

    // The regression. The removed account can never re-score — it is not in the orphan
    // pool — so the cleanup must leave it alone: the row stands untouched, confidence and
    // signals included, not merely re-created.
    expect(await identityMembers(IDS.marit)).toEqual(before);

    // The paired case, and what keeps the fix from being "the cleanup removes nothing":
    // the *live* account in the same position is detached, exactly as #1450 intends, and
    // comes back as a held-for-review match naming the rival.
    expect(await linkedPrincipalIds(IDS.sanne)).toEqual([]);

    // Not an exact count: the figure is deployment-wide and whatever else this tenant
    // holds is not this spec's to predict. That it detached the live account and not the
    // removed one is pinned above, per account, which is the discriminating form.
    const run = await latestCompletedRun();
    expect(run?.linksRemoved, 'the live account should have been detached').toBeGreaterThanOrEqual(1);
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.liveAccount);
    expect(held, `the run did not report the held match for ${LIVE_NAME} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    // The removed account is not on that card either: it was neither detached nor held.
    expect((run?.nameOnlySuggestions ?? []).some(s => s.principalId === IDS.removedAccount)).toBe(false);
  });

  test('the identity page still shows the removed account under Linked Accounts', async ({ page }) => {
    // Where the reporter looked. The API half above proves the row survives; this proves
    // the person reading the identity still sees the account, which is what was lost.
    await page.goto(`${BASE}/#identity:${IDS.marit}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: NAME, exact: true })).toBeVisible({ timeout: 15000 });

    // And the live namesake's account really is gone from hers.
    await page.goto(`${BASE}/#identity:${IDS.sanne}`);
    const sannePanel = await linkedAccountsPanel(page);
    await expect(sannePanel.getByRole('button', { name: LIVE_NAME, exact: true })).toHaveCount(0);
  });
});
