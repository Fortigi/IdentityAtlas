// @ts-check
//
// A tenant that has ever saved its Account Linking settings never used to get a
// signal shipped afterwards. Save writes the whole dictionary the editor was
// showing — moving the certainty slider is enough — and the API merged that row
// over the shipped defaults at the top level only, so the saved `signals` array
// replaced the shipped one wholesale. `loginNameForm` (#1466) was inert for
// every such tenant, their `adm-<initial><surname>` accounts stayed orphaned,
// and the settings editor showed and re-saved the same stale list, with nothing
// on screen to say a signal was missing (#1469).
//
// This spec walks the reporter's own path against the live deployment:
//
//   1. save a dictionary with no login-reading signal in it — exactly what a
//      pre-#1466 Save persisted,
//   2. Admin → Account Linking: the editor shows the signal back, merged into
//      the saved dictionary, and says plainly that deleting one does not
//      disable it,
//   3. Admin → Account Linking → Run now,
//   4. Identities → the person's detail page → Linked Accounts: the
//      `adm-<initial><surname>` account is THERE, on the login route, which is
//      the regression,
//   5. the Orphaned Accounts report no longer lists it,
//   6. a link that rests on a display name — the kind a tenant already had
//      before the upgrade — is neither detached nor re-scored by the run that
//      merged the new signal in.
//
// (2) and (4)–(6) are the assertions a unit test cannot make: they read the
// stored rules back through the endpoint the editor actually renders, the links
// back through the identities API and the report, and (6) runs the engine twice
// against one database. The pre-upgrade run itself cannot be replayed on a
// deployment that already has the fix — the merge applies the moment the rules
// are read — so (6) pins the half that is observable here: the merged
// dictionary leaves a standing name-only link exactly where it was, at the
// confidence and on the signals it was made with.
//
// Seeded through the ingest API under a system of its own with a per-run name
// token, like the other account-linking specs: the demo dataset builds its admin
// logins as `adm-` + the owner's exact local part, so the `f.h.` / `f` mismatch
// the login route exists for is not in it by construction.
//
// THIS SPEC WRITES THE DEPLOYMENT'S LINKING CONFIG. There is one config row per
// deployment, so it stores the config it found on the way in and puts it back on
// the way out — and the run is a real POST, so it links accounts the same way
// the post-crawl auto-run does. Both are deliberate: a dictionary nobody saved
// and a dry run would not reproduce this bug.
//
// One residue it cannot clear: on a deployment that had never saved its settings
// the restore leaves a stored row holding the dictionary that was in force. The
// rules are the same ones either way — the merge is idempotent — so the only
// difference is that the settings page stops calling them shipped defaults.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, openIngestSession, closeIngestSession, linkingConfig, saveLinkingRules,
  runAccountLinkingFromAdmin, latestCompletedRun, identityMembers, linkedPrincipalIds,
  linkedAccountsPanel, orphanReport,
} from './accountLinkingSeed';

const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const DOMAIN = 'e2e-1469.example';

// Single-token surnames, so the name parser cannot read a particle as the
// surname and change what is being asked here.
const SOLE = `Hogenbirkz${TOKEN}`;   // the login route's person
const NAMED = `Eusonz${TOKEN}`;      // the display-name route's person

const IDS = {
  fay: randomUUID(), robin: randomUUID(),
  admFay: randomUUID(), extraRobin: randomUUID(), svc: randomUUID(),
};

const NAMES = {
  fay: `Fay ${SOLE}`,
  robin: `Robin ${NAMED}`,
  admFay: `Admin account ${TOKEN}-1`,
  extraRobin: `${NAMED}, Robin`,
  svc: `Service account ${TOKEN}`,
};

// Her mailbox carries two initials; her admin login carries one. No amount of
// separator stripping bridges `f.h.hogenbirkz…` and `fhogenbirkz…`, which is why
// only a signal that reads the login as a NAME can place that account.
const IDENTITIES = [
  {
    id: IDS.fay, displayName: NAMES.fay, givenName: 'Fay', surname: SOLE,
    email: `f.h.${SOLE}@${DOMAIN}`.toLowerCase(), employeeId: `E2E1469-FAY-${TOKEN}`,
    companyName: 'E2E #1469',
  },
  {
    id: IDS.robin, displayName: NAMES.robin, givenName: 'Robin', surname: NAMED,
    email: `r.${NAMED}@${DOMAIN}`.toLowerCase(), employeeId: `E2E1469-ROB-${TOKEN}`,
    companyName: 'E2E #1469',
  },
];

// Neither account holds an employeeId — that would link it at weight 95 and
// never exercise a name route at all.
const ACCOUNTS = [
  // Nothing but a login: the display name carries no person's name.
  {
    id: IDS.admFay, displayName: NAMES.admFay, email: `adm-f${SOLE}@${DOMAIN}`.toLowerCase(),
    principalType: 'User', accountEnabled: true,
  },
  // The opposite: a second account whose DISPLAY NAME spells its owner, and
  // whose address says nothing. This is the link a tenant already had before the
  // upgrade, and the one the merge must leave alone.
  {
    id: IDS.extraRobin, displayName: NAMES.extraRobin, email: `robin.extra.${TOKEN}@${DOMAIN}`.toLowerCase(),
    principalType: 'User', accountEnabled: true,
  },
  // The control: a service account, which no dictionary attaches to a person —
  // `onlyLinkTypes` leaves it for the Orphaned Accounts report instead.
  {
    id: IDS.svc, displayName: NAMES.svc, email: `svc-batch-${TOKEN}@${DOMAIN}`.toLowerCase(),
    principalType: 'User', accountEnabled: true,
  },
];

/** The login-reading signal in a dictionary, or undefined. */
const loginSignal = (rules) => (rules?.signals || []).find(s => s.type === 'loginName');

/** One identity's member row for an account, as the identities API serves it. */
const memberFor = async (identityId, principalId) =>
  (await identityMembers(identityId)).find(m => m.principalId === principalId);

let restoreConfig = null;   // the config this deployment had before we touched it
let savedRules = null;      // the pre-upgrade dictionary we stored
let seeded = null;
let standingLink = null;    // robin's display-name link, as the first run made it

test.beforeAll(async () => {
  const config = await linkingConfig();
  test.skip(!config, 'account-linking config endpoint not available to this user');
  test.skip(!loginSignal(config.rules), 'this deployment ships no login-reading signal to merge');

  // The fixture rests on the login alone. A deployment that raised the certainty
  // slider past that signal's weight, or that stopped linking Admin accounts,
  // would hold the account back for reasons that are not this bug.
  const { rules } = config;
  test.skip(
    !(rules.onlyLinkTypes || []).includes('Admin') || (rules.linkThreshold ?? 0) > (loginSignal(rules).weight ?? 0),
    'the deployment\'s linking rules would not link on a login alone',
  );

  seeded = await openIngestSession({
    displayName: `e2e-1469-${TOKEN}`,
    description: 'Throwaway key for the #1469 account-linking E2E. Removed by the spec.',
    system: { systemType: 'HR', tenantId: `e2e-1469-${TOKEN}`, displayName: `E2E #1469 HR (${TOKEN})` },
  });
  if (!seeded.ok) return;
  await seeded.mustIngest('identities', { records: IDENTITIES });
  await seeded.mustIngest('principals', { records: ACCOUNTS });

  // Step 1 of the repro: the Save a pre-#1466 build made. Every value this
  // deployment runs on, with the login-reading signal taken out of the list —
  // which is all that build's dictionary differed by.
  restoreConfig = config;
  savedRules = { ...rules, signals: (rules.signals || []).filter(s => s.type !== 'loginName') };
  if (!(await saveLinkingRules(savedRules, { schedules: config.schedules || [], isActive: true }))) {
    savedRules = null; // refused — the specs below skip
  }
});

test.afterAll(async () => {
  // The config row is shared, so put back what was there — including an
  // `isActive` this spec must not flip for the next run of the suite.
  if (savedRules && restoreConfig) {
    await saveLinkingRules(restoreConfig.rules, {
      schedules: restoreConfig.schedules || [],
      isActive: restoreConfig.isActive !== false,
    }).catch(() => {});
  }
  if (seeded?.systemId) {
    // Off every human-facing surface on the way out: a tombstoned account is no
    // longer an orphan, but the rows outlive the retention window.
    await seeded.ingest('principals', { deletedIds: ACCOUNTS.map(a => a.id) }).catch(() => {});
  }
  await closeIngestSession(seeded, {
    identityIds: IDENTITIES.map(i => i.id),
    systemNote: 'Disabled leftover of the #1469 account-linking E2E.',
  });
});

test.describe('Account linking — a saved dictionary and a signal shipped after it (#1469)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(!seeded?.ok, 'could not seed through the ingest API (SQL mode required)');
    test.skip(!savedRules, 'the deployment refused the config save this spec needs');
  });

  test('the active rules gain the shipped signal and keep every saved value', async () => {
    // What the engine will run on, read off the deployment's own endpoint. The
    // stored row has no login-reading signal; the effective dictionary does,
    // with its shipped weight — and nothing the tenant saved moved.
    const effective = (await linkingConfig())?.rules;

    expect(loginSignal(savedRules), 'the fixture stored a dictionary that still had one').toBeUndefined();
    const merged = loginSignal(effective);
    expect(merged, 'the saved dictionary did not gain the shipped login signal').toBeTruthy();
    expect(merged.stripPrefixes).toContain('adm-');
    expect(merged.weight).toBe(loginSignal(restoreConfig.rules).weight);

    expect(effective.linkThreshold).toBe(savedRules.linkThreshold);
    expect(effective.onlyLinkTypes).toEqual(savedRules.onlyLinkTypes);
    expect(effective.allowNameOnlyLinks).toBe(savedRules.allowNameOnlyLinks);
    expect(effective.accountTypeRules).toEqual(savedRules.accountTypeRules);
    // Every signal the tenant did save is still exactly as they saved it.
    for (const saved of savedRules.signals) {
      expect(effective.signals.find(s => s.name === saved.name)).toEqual(saved);
    }
  });

  test('the settings editor shows that dictionary, and says weight 0 is the off-switch', async ({ page }) => {
    // Where the reporter looked. The editor renders what GET /config serves and
    // Save writes it straight back, so a stale list here is also the next thing
    // persisted. The note matters as much as the list: a signal reappearing in
    // the JSON reads as "my edit was discarded" until the page says why.
    await page.goto(`${BASE}/#admin?sub=account-linking`);
    const editor = page.getByRole('textbox', { name: /Linking rules \(JSON\)/i });
    await expect(editor).toBeVisible({ timeout: 30000 });

    const shown = JSON.parse(await editor.inputValue());
    expect(loginSignal(shown), 'the editor is showing the stale saved list').toBeTruthy();

    await expect(page.getByText(/Deleting a signal here does not disable it/i)).toBeVisible();
    await expect(page.getByText(/set its weight to 0/i)).toBeVisible();
  });

  test('a run attaches the account the saved dictionary could never attach', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);

    // The regression: nobody else in this tenant is an F. Hogenbirkz…, so this
    // account is hers — on a signal her saved dictionary did not contain.
    expect(await linkedPrincipalIds(IDS.fay)).toContain(IDS.admFay);
    const link = await memberFor(IDS.fay, IDS.admFay);
    expect(link.linkSignals).toBe(loginSignal(restoreConfig.rules).name);

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.fay}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: NAMES.admFay, exact: true })).toBeVisible({ timeout: 15000 });

    // The link that rests on a display name — unaffected by the new signal, and
    // the baseline the second run is measured against.
    standingLink = await memberFor(IDS.robin, IDS.extraRobin);
    expect(standingLink, 'the display-name account did not link at all').toBeTruthy();
  });

  test('the report stops calling it outstanding work, and still calls the service account that', async () => {
    const outstanding = (await orphanReport()).rows.map(r => r.displayName);

    // The half of the symptom an analyst actually works from: the account was
    // listed as unplaced. A link that leaves it on this report has not placed it.
    expect(outstanding).not.toContain(NAMES.admFay);
    // …and the merge adds signals, not account types: a service account is left
    // for this report under any dictionary, so its row here is what stops a
    // report that broke entirely from reading as a pass.
    expect(outstanding).toContain(NAMES.svc);
  });

  test('the next run detaches nothing and re-scores nothing', async ({ page }) => {
    // The acceptance criterion that guards the upgrade: merging a name-class
    // signal into a tenant's dictionary adds a reading of every account the
    // retroactive cleanup scans, and that cleanup is the only code here that
    // DELETES a link. A standing display-name link must come through it
    // untouched — not detached, and not re-created at a new confidence on a new
    // signal list, which would churn the account's history on every run.
    await runAccountLinkingFromAdmin(page);
    const second = await latestCompletedRun();

    expect(second.status).toBe('completed');
    expect(second.linksRemoved, 'the second run detached links the first one settled').toBe(0);
    expect(await memberFor(IDS.robin, IDS.extraRobin)).toMatchObject({
      linkSignals: standingLink.linkSignals,
      linkConfidence: standingLink.linkConfidence,
    });
    expect(await linkedPrincipalIds(IDS.fay)).toContain(IDS.admFay);
  });
});
