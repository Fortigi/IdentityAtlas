// @ts-check
//
// A source that shows a person as "Surname, Initials" and nothing else — the
// shape most ERP, finance and payroll exports use: no address, no employee
// number, no login. The strongest evidence such a name can produce was a surname
// plus one initial, which sits below the certainty bar, so the account was never
// even a scoring candidate. Measured on a 7,000-identity dataset, its ≈2,100
// accounts linked **zero** times and sat in Orphaned Accounts for ever (#1455).
//
// The answer is deliberately not a lower bar — that would hand an ambiguous
// `Jansen, J.` to whichever J. Jansen scored first. It is to read all the
// evidence the name carries (every initial, not just the first), and to let the
// name-uniqueness guard add what it establishes beside it: that nobody else
// answers to the name, or that a department or a manager singles one of the
// people who do out.
//
// This spec walks that against the live deployment:
//
//   1. Admin → Account Linking → Run now,
//   2. Identities → the owner's detail page → Linked Accounts: an account showing
//      only `van Mourik, R.` is THERE, which is the regression, and the link
//      records that it rests on initials rather than claiming more than it has,
//   3. all the initials count: `Buskes, L.R.` goes to the Laura Renée it singles
//      out and not to the Lars who shares only the first letter,
//   4. the paired holds, which are what stop the fix being "link every initials
//      match": one initial two people answer to, and two initials two people
//      state, are each held for review with the rival named — and the
//      held-for-review card says which name the rivals share, a different
//      sentence per rung,
//   5. initials that disagree in two places rule a person out: the account is
//      neither linked NOR held, because a hold would send a reviewer after a
//      match the evidence has already answered,
//   6. context narrows and never picks: a department that is one namesake's and
//      no other's settles the account, two namesakes sharing one leaves it held,
//   7. the Orphaned Accounts report agrees with all of it — the placed accounts
//      are off it, the held and blocked ones are still on it,
//   8. the manager evidence across runs: it resolves through the manager's own
//      account, so it cannot fire until that account is itself linked. The match
//      is held on the first run and placed on the second — the bootstrap gap,
//      stated as behaviour,
//   9. convergence. A third run detaches nothing, so the links the guard's
//      evidence settled stand instead of being detached and re-created on every
//      run for ever.
//
// (2)–(9) are the assertions a unit test cannot make. They read the stored links
// back through the identities API and the report, and (8)–(9) run the engine
// three times against one database. The retroactive cleanup re-judges every
// name-only link, and the links this feature makes rest on a name two people may
// answer to — so a cleanup that reads only the name detaches exactly the links
// the guard creates, re-creates them from the orphan pool in the same run, and
// churns each account's history for ever. Every mocked fixture gives a name one
// claimant, where that is invisible; only a live database shows it.
//
// Seeded through the ingest API under a system of its own with a per-run name
// token: the demo dataset carries no "Surname, Initials" source at all, and its
// accounts come pre-linked on employeeId, so none of this is in it by
// construction.
//
// The run is a real POST, so this spec changes deployment state — it links
// accounts the same way the post-crawl auto-run does. That is deliberate: a
// dry-run would not prove the writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, seedLinkingFixture, clearLinkingFixture, linkingRules,
  runAccountLinkingFromAdmin, latestCompletedRun, linkedAccountNames, linkedPrincipalIds,
  identityMembers, linkedAccountsPanel, orphanReport,
} from './accountLinkingSeed';

/** The issue this spec replays, which names the throwaway connector and system. */
const ISSUE = '1455';

/**
 * A per-run name token made of LETTERS only — a surname ending in a digit run
 * reads as a numbered login form (#1468), which is a different question.
 */
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8).replace(/[0-9]/g, d => 'ghijklmnop'[Number(d)]);

// One surname stem per case, unique to this run, so no case can be answered by
// another's fixture and the tenant's own people stay out of these assertions.
const STEMS = {
  mourik: `Mourikz${TOKEN}`,   // the regression: one initial, nobody else answers to it
  jansen: `Jansenz${TOKEN}`,   // the paired hold: one initial, two claimants
  buskes: `Buskesz${TOKEN}`,   // two initials single one of two out
  dekker: `Dekkerz${TOKEN}`,   // the paired hold: two people state the same two initials
  hofman: `Hofmanz${TOKEN}`,   // two initials that disagree rule the sole claimant out
  vos: `Voszz${TOKEN}`,        // a department settles two namesakes
  riet: `Rietzz${TOKEN}`,      // the paired hold: both namesakes share the department
  beek: `Beekzz${TOKEN}`,      // a manager settles them, on the run after he links
  chef: `Chefzz${TOKEN}`,      // the managers themselves
  zand: `Zandvlietz${TOKEN}`,  // the control: nobody answers to the initials at all
};

const IDS = {
  robin: randomUUID(),
  jan: randomUUID(), johannes: randomUUID(),
  laura: randomUUID(), lars: randomUUID(),
  lieke: randomUUID(), lotte: randomUUID(),
  lucasWillem: randomUUID(),
  annaFinance: randomUUID(), annaFacilities: randomUUID(),
  maraA: randomUUID(), maraB: randomUUID(),
  noraHis: randomUUID(), noraHers: randomUUID(),
  bossHis: randomUUID(), bossHers: randomUUID(),
  // The accounts.
  erpRobin: randomUUID(), erpJansen: randomUUID(), erpLaura: randomUUID(),
  erpDekker: randomUUID(), erpHofman: randomUUID(), erpAnna: randomUUID(),
  erpMara: randomUUID(), erpNora: randomUUID(), erpNobody: randomUUID(),
  bossAccount: randomUUID(),
};

/** The two departments the context case turns on, named after this run. */
const DEPTS = { finance: `E2E${ISSUE} Finance`, facilities: `E2E${ISSUE} Facilities`, legal: `E2E${ISSUE} Legal` };

const NAMES = {
  robin: `Robin van ${STEMS.mourik}`,
  jan: `Jan ${STEMS.jansen}`,
  johannes: `Johannes ${STEMS.jansen}`,
  laura: `Laura Renée ${STEMS.buskes}`,
  lars: `Lars ${STEMS.buskes}`,
  lieke: `Lieke Roos ${STEMS.dekker}`,
  lotte: `Lotte Rosa ${STEMS.dekker}`,
  lucasWillem: `Lucas Willem ${STEMS.hofman}`,
  anna: `Anna ${STEMS.vos}`,
  mara: `Mara ${STEMS.riet}`,
  nora: `Nora ${STEMS.beek}`,
  bossHis: `Pieter ${STEMS.chef}`,
  bossHers: `Paula ${STEMS.chef}`,
};

/** The display name each ERP account shows — which is all the evidence it has. */
const SHOWN = {
  erpRobin: `van ${STEMS.mourik}, R.`,
  erpJansen: `${STEMS.jansen}, J.`,
  erpLaura: `${STEMS.buskes}, L.R.`,
  erpDekker: `${STEMS.dekker}, L.R.`,
  erpHofman: `${STEMS.hofman}, L.R.`,
  erpAnna: NAMES.anna,
  erpMara: NAMES.mara,
  erpNora: NAMES.nora,
  erpNobody: `${STEMS.zand}, Q.`,
};

/**
 * An HR person, with `given` passed separately because the whole point of these
 * fixtures is the given half's own words: every initial past the first survives
 * only there, so "Laura Renée" has to reach the engine as two words to be the
 * `L.R.` the ERP shows.
 *
 * They hold a mailbox and an employee number, as an HR record does, and neither
 * is ever what an account below is matched on.
 */
const person = (id, displayName, given, surname, extra = {}) => ({
  id,
  displayName,
  givenName: given,
  surname,
  email: `${id.slice(0, 8)}@e2e-${ISSUE}.example`,
  employeeId: `E2E${ISSUE}-${id.slice(0, 8)}`,
  companyName: `E2E #${ISSUE}`,
  ...extra,
});

/**
 * An ERP account: a display name and nothing else. No address and no employee
 * number is the condition this whole feature is about — with either of them the
 * account would link on a strong signal and say nothing about initials.
 */
const erpAccount = (id, displayName, extra = {}) => ({
  id, displayName, principalType: 'User', accountEnabled: true, ...extra,
});

const IDENTITIES = [
  // The regression: one R. van Mourik, and nobody else near the name.
  person(IDS.robin, NAMES.robin, 'Robin', `van ${STEMS.mourik}`),
  // Its paired hold: two people answer to `J. Jansen`.
  person(IDS.jan, NAMES.jan, 'Jan', STEMS.jansen),
  person(IDS.johannes, NAMES.johannes, 'Johannes', STEMS.jansen),
  // Two initials single Laura out; Lars shares only the first letter.
  person(IDS.laura, NAMES.laura, 'Laura Renée', STEMS.buskes),
  person(IDS.lars, NAMES.lars, 'Lars', STEMS.buskes),
  // Its paired hold: two people state L. R. — more letters is not unambiguous.
  person(IDS.lieke, NAMES.lieke, 'Lieke Roos', STEMS.dekker),
  person(IDS.lotte, NAMES.lotte, 'Lotte Rosa', STEMS.dekker),
  // The sole claimant the account's own second initial rules out: L.W., not L.R.
  person(IDS.lucasWillem, NAMES.lucasWillem, 'Lucas Willem', STEMS.hofman),
  // Two people really called Anna Vos, in different departments.
  person(IDS.annaFinance, NAMES.anna, 'Anna', STEMS.vos, { department: DEPTS.finance }),
  person(IDS.annaFacilities, NAMES.anna, 'Anna', STEMS.vos, { department: DEPTS.facilities }),
  // Its paired hold: two namesakes in ONE department.
  person(IDS.maraA, NAMES.mara, 'Mara', STEMS.riet, { department: DEPTS.legal }),
  person(IDS.maraB, NAMES.mara, 'Mara', STEMS.riet, { department: DEPTS.legal }),
  // Two Nora Beeks, told apart by nothing but who they report to. Neither
  // records a department, so the manager is the only evidence there can be.
  person(IDS.noraHis, NAMES.nora, 'Nora', STEMS.beek, { managerIdentityId: IDS.bossHis }),
  person(IDS.noraHers, NAMES.nora, 'Nora', STEMS.beek, { managerIdentityId: IDS.bossHers }),
  person(IDS.bossHis, NAMES.bossHis, 'Pieter', STEMS.chef),
  person(IDS.bossHers, NAMES.bossHers, 'Paula', STEMS.chef),
];

const ACCOUNTS = [
  erpAccount(IDS.erpRobin, SHOWN.erpRobin),
  erpAccount(IDS.erpJansen, SHOWN.erpJansen),
  erpAccount(IDS.erpLaura, SHOWN.erpLaura),
  erpAccount(IDS.erpDekker, SHOWN.erpDekker),
  erpAccount(IDS.erpHofman, SHOWN.erpHofman),
  // The department is sent in a different case and with stray padding, which is
  // all the normalisation there is: departments are compared exactly after that,
  // never fuzzily — "Finance" and "Finance & Control" are two departments as
  // often as they are one.
  erpAccount(IDS.erpAnna, SHOWN.erpAnna, { department: `  ${DEPTS.finance.toLowerCase()} ` }),
  erpAccount(IDS.erpMara, SHOWN.erpMara, { department: DEPTS.legal }),
  // Her manager is a PRINCIPAL — his own ERP account below — so the person behind
  // it exists only once that account is linked. On run 1 it is not.
  erpAccount(IDS.erpNora, SHOWN.erpNora, { managerId: IDS.bossAccount }),
  // His own account, and the only one here carrying an employee number: it links
  // on that, which is what makes her manager resolvable on the next run.
  erpAccount(IDS.bossAccount, NAMES.bossHis, { employeeId: `E2E${ISSUE}-${IDS.bossHis.slice(0, 8)}` }),
  erpAccount(IDS.erpNobody, SHOWN.erpNobody),
];

const FIXTURE = { issue: ISSUE, token: TOKEN, identities: IDENTITIES, accounts: ACCOUNTS };

/** The active weight of one signal, 0 for a signal this dictionary has not got. */
const weightOf = (rules, name) => (rules?.signals || []).find(s => s.name === name)?.weight ?? 0;

/**
 * Why this deployment cannot be asked whether a "Surname, Initials" account is
 * placeable, or `''` when it can.
 *
 * The fixture rests on the shipped ladder: that plain extra accounts are linked
 * at all, that a name alone may place one, that both initials rungs are switched
 * on, and that the certainty slider sits at or below what a unique single-initial
 * match scores (the rung's own weight plus the uniqueness the guard adds). None
 * of that is the feature under test, so a tenant that retuned it skips rather
 * than fails — and is told which of the four it was.
 */
function initialsLinkingBlocker(rules) {
  if (!(rules?.onlyLinkTypes || []).includes('Secondary')) return 'this deployment does not link Secondary accounts';
  if (rules?.allowNameOnlyLinks === false) return 'this deployment never links on a name alone';
  for (const name of ['surnameInitial', 'surnameInitials', 'nameUnique', 'department', 'manager']) {
    if (!weightOf(rules, name)) return `the active dictionary has ${name} switched off`;
  }
  const unique = weightOf(rules, 'surnameInitial') + weightOf(rules, 'nameUnique');
  if ((rules?.linkThreshold ?? 0) > unique) {
    return `the certainty slider (${rules.linkThreshold}) sits above a unique initials match (${unique})`;
  }
  return '';
}

/** One identity's member row for an account, as the identities API serves it. */
const memberFor = async (identityId, principalId) =>
  (await identityMembers(identityId)).find(m => m.principalId === principalId);

/** The newest completed run's held-for-review record for an account, if any. */
const heldFor = async (principalId) =>
  ((await latestCompletedRun())?.nameOnlySuggestions ?? []).find(s => s.principalId === principalId);

/** Everything the newest completed run held back, by account id. */
const heldIds = async () =>
  ((await latestCompletedRun())?.nameOnlySuggestions ?? []).map(s => s.principalId);

let rules;
let seeded = null;
let firstRun = null;

test.beforeAll(async () => {
  rules = await linkingRules();
  test.skip(!rules, 'account-linking config endpoint not available to this user');
  seeded = await seedLinkingFixture(FIXTURE);
});

test.afterAll(() => clearLinkingFixture(seeded, FIXTURE));

test.describe('Account linking — accounts that show only "Surname, Initials" (#1455)', () => {
  test.describe.configure({ mode: 'serial', timeout: 420000 });

  test.beforeEach(() => {
    test.skip(!seeded?.ok, `could not seed through the ingest API (SQL mode required): ${seeded?.reason}`);
    const blocker = initialsLinkingBlocker(rules);
    test.skip(!!blocker, `this deployment would not place a "Surname, Initials" account — ${blocker}`);
  });

  test('an account showing only a surname and one initial lands on its owner', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);
    firstRun = await latestCompletedRun();
    expect(firstRun?.status).toBe('completed');

    // The regression. This account carries no address and no employee number, so
    // before the fix it was not scored at all and stayed an orphan for ever.
    expect(await linkedPrincipalIds(IDS.robin)).toContain(IDS.erpRobin);

    // What it rests on, which is the issue's own reject criterion: a link made on
    // initials must say so, or an analyst cannot tell it from a certain one.
    const link = await memberFor(IDS.robin, IDS.erpRobin);
    expect(link.linkSignals.split(',')).toEqual(['surnameInitial', 'nameUnique']);
    expect(link.linkConfidence)
      .toBe(weightOf(rules, 'surnameInitial') + weightOf(rules, 'nameUnique'));

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.robin}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: SHOWN.erpRobin, exact: true }))
      .toBeVisible({ timeout: 15000 });
  });

  test('one initial two people answer to is held for review, with the rival named', async () => {
    // The paired case, and what stops the fix being a lower bar: two people
    // answer to `J. Jansen`, so nothing in the name says which, and handing it to
    // whichever of them scored first is the outcome the issue rejects.
    expect(await linkedAccountNames(IDS.jan)).toEqual([]);
    expect(await linkedAccountNames(IDS.johannes)).toEqual([]);

    const held = await heldFor(IDS.erpJansen);
    expect(held, `the run did not report the held match for ${SHOWN.erpJansen} `
      + `(stored list is capped at 500; this run held ${firstRun?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('surnameInitial');
    expect(held.rivalCount).toBe(1);
    expect([held.identityId, ...held.rivals.map(r => r.identityId)].sort())
      .toEqual([IDS.jan, IDS.johannes].sort());
  });

  test('all the initials count, not just the first', async ({ page }) => {
    // `L.R.` against Laura Renée and Lars: one letter leaves both of them, two
    // letters leave one. Reading only the first initial threw that away, and a
    // lower bar would have decided it by luck.
    expect(await linkedPrincipalIds(IDS.laura)).toContain(IDS.erpLaura);
    expect(await linkedAccountNames(IDS.lars)).toEqual([]);

    const link = await memberFor(IDS.laura, IDS.erpLaura);
    expect(link.linkSignals.split(',')).toEqual(['surnameInitials', 'nameUnique']);
    expect(link.linkConfidence)
      .toBe(weightOf(rules, 'surnameInitials') + weightOf(rules, 'nameUnique'));

    await page.goto(`${BASE}/#identity:${IDS.laura}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: SHOWN.erpLaura, exact: true }))
      .toBeVisible({ timeout: 15000 });
  });

  test('two people who state the same initials hold the match at the initials rung', async () => {
    // The paired case for the one above: more letters is not the same as
    // unambiguous. Lieke Roos and Lotte Rosa both state L. R.
    expect(await linkedAccountNames(IDS.lieke)).toEqual([]);
    expect(await linkedAccountNames(IDS.lotte)).toEqual([]);

    const held = await heldFor(IDS.erpDekker);
    expect(held, `the run did not report the held match for ${SHOWN.erpDekker}`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    // Not `surnameInitial`: the rivals share the whole sequence, which is a
    // different finding and a different sentence on the card below.
    expect(held.matchLevel).toBe('surnameInitials');
    expect(held.rivalCount).toBe(1);
  });

  test('initials that disagree rule the only claimant out — no link, and no hold', async () => {
    // `L.R.` against the sole Lucas Willem of the tenant. Two letters that
    // disagree are a statement about who the account is NOT, so holding it would
    // send a reviewer after a match the evidence has already answered.
    expect(await linkedAccountNames(IDS.lucasWillem)).toEqual([]);
    expect(await heldIds()).not.toContain(IDS.erpHofman);
  });

  test('a department settles two namesakes, and the link says it did', async () => {
    // Context narrows the people the NAME allows. Both Annas are spelled exactly
    // this account's name, so the name settles nothing; Finance is one of theirs
    // and not the other's. Compared after lower-casing and trimming, and no
    // further — the account sends it padded and in another case.
    expect(await linkedPrincipalIds(IDS.annaFinance)).toContain(IDS.erpAnna);
    expect(await linkedAccountNames(IDS.annaFacilities)).toEqual([]);

    const link = await memberFor(IDS.annaFinance, IDS.erpAnna);
    expect(link.linkSignals.split(',')).toEqual(['fullName', 'department']);
    expect(link.linkConfidence).toBe(weightOf(rules, 'fullName') + weightOf(rules, 'department'));
  });

  test('two namesakes in one department leave the account held', async () => {
    // The paired case, and the rule: context narrows, it never picks. A
    // department both claimants share says nothing about which of them the
    // account is, so it must not go to whichever scored first.
    expect(await linkedAccountNames(IDS.maraA)).toEqual([]);
    expect(await linkedAccountNames(IDS.maraB)).toEqual([]);

    const held = await heldFor(IDS.erpMara);
    expect(held, `the run did not report the held match for ${SHOWN.erpMara}`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('full');
  });

  test('an initials spelling nobody answers to is attributed to nobody', async () => {
    // The guard on the whole feature: reading more of a name must widen who an
    // account can belong to, never make it belong to somebody at random. Nobody
    // in this tenant is a Q. Zandvliet, so no identity may hold this account and
    // no held match may claim it either.
    expect(await heldIds()).not.toContain(IDS.erpNobody);
    for (const identity of IDENTITIES) {
      expect(await linkedPrincipalIds(identity.id), `${identity.displayName} inherited the account that names nobody`)
        .not.toContain(IDS.erpNobody);
    }
  });

  test('the placed accounts are off the Orphaned Accounts report, the held ones are still on it', async () => {
    // The half of the symptom an analyst works from: these accounts were listed
    // as outstanding work, every run, for ever. A link that leaves one on this
    // report has not placed it.
    const outstanding = (await orphanReport()).rows.map(r => r.displayName);
    expect(outstanding).not.toContain(SHOWN.erpRobin);
    expect(outstanding).not.toContain(SHOWN.erpLaura);
    expect(outstanding).not.toContain(SHOWN.erpAnna);
    // The controls — held, blocked and unclaimed are genuinely still there, so a
    // report that broke entirely cannot read as a pass.
    expect(outstanding).toContain(SHOWN.erpJansen);
    expect(outstanding).toContain(SHOWN.erpDekker);
    expect(outstanding).toContain(SHOWN.erpHofman);
    expect(outstanding).toContain(SHOWN.erpMara);
    expect(outstanding).toContain(SHOWN.erpNobody);
  });

  test('the held-for-review card names the rivals and which name they share', async ({ page }) => {
    await page.goto(`${BASE}/#admin?sub=account-linking`);
    await page.waitForLoadState('networkidle');

    const table = page.getByRole('table', { name: /Name-only matches held for review/i });
    if (!(await table.isVisible({ timeout: 15000 }).catch(() => false))) {
      test.skip(true, 'Account Linking admin tab not available to this user (needs admin.crawlers)');
    }

    // One sentence per rung, because they are not the same finding: at
    // `surnameInitials` the rivals state the account's whole sequence of
    // initials, at `surnameInitial` they merely share its surname and first
    // letter. One wording for both would send the analyst looking for a namesake
    // who does not exist.
    const initials = table.locator('tr', { hasText: SHOWN.erpDekker }).first();
    await expect(initials).toBeVisible({ timeout: 15000 });
    await expect(initials.getByText(/surname and initials also shared by/i)).toBeVisible();

    const initial = table.locator('tr', { hasText: SHOWN.erpJansen }).first();
    await expect(initial).toBeVisible();
    await expect(initial.getByText(/surname and first initial also shared by/i)).toBeVisible();

    // The accounts the run placed are not on this card at all — they are not
    // held, they are linked.
    await expect(table.locator('tr', { hasText: SHOWN.erpRobin })).toHaveCount(0);
    await expect(table.locator('tr', { hasText: SHOWN.erpLaura })).toHaveCount(0);
  });

  test('the manager evidence fires on the run after the manager’s own account links', async ({ page }) => {
    // The bootstrap gap, which only a live database shows. Her manager is a
    // PRINCIPAL; what the guard compares is the person behind it, and that person
    // exists only once the manager's own account is linked. On run 1 it was not,
    // so nothing settled the two Nora Beeks and the match was held.
    const firstHold = (firstRun?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.erpNora);
    expect(firstHold, 'the first run should have held her account, not placed it').toBeTruthy();
    expect(firstHold.reason).toBe('ambiguousName');

    // Run 1 did link HIS account, on its employee number, so run 2 can resolve her
    // manager to a person.
    expect(await linkedPrincipalIds(IDS.bossHis)).toContain(IDS.bossAccount);

    await runAccountLinkingFromAdmin(page);
    const second = await latestCompletedRun();
    expect(second.status).toBe('completed');
    // The run that settled it, and nothing detached on the way: the three links
    // run 1 made rest on names a namesake or nobody answers to, and a cleanup
    // that re-judges them on the name alone takes all three.
    expect(second.linksRemoved, 'the second run detached links the first one settled').toBe(0);

    expect(await linkedPrincipalIds(IDS.noraHis)).toContain(IDS.erpNora);
    expect(await linkedAccountNames(IDS.noraHers)).toEqual([]);
    const link = await memberFor(IDS.noraHis, IDS.erpNora);
    expect(link.linkSignals.split(',')).toEqual(['fullName', 'manager']);
    expect(link.linkConfidence).toBe(weightOf(rules, 'fullName') + weightOf(rules, 'manager'));
  });

  test('a third run detaches nothing, so none of these links churns', async ({ page }) => {
    // Convergence, and the assertion that cannot be mocked. The cleanup is the
    // only code here that DELETES a link, and it judges every name-only link on
    // every run — including the ones whose name points at two people and which
    // only a department or a manager settles. A cleanup blind to that evidence
    // detaches them, the same run re-creates them from the orphan pool, and each
    // account's history churns for ever while every unit test stays green.
    await runAccountLinkingFromAdmin(page);
    const third = await latestCompletedRun();

    expect(third.status).toBe('completed');
    expect(third.linksRemoved, 'the third run re-detached links the earlier ones settled').toBe(0);
    expect(await linkedPrincipalIds(IDS.robin)).toContain(IDS.erpRobin);
    expect(await linkedPrincipalIds(IDS.laura)).toContain(IDS.erpLaura);
    expect(await linkedPrincipalIds(IDS.annaFinance)).toContain(IDS.erpAnna);
    expect(await linkedPrincipalIds(IDS.noraHis)).toContain(IDS.erpNora);
    // ...and the holds have not quietly become links either.
    const stillHeld = await heldIds();
    for (const id of [IDS.erpJansen, IDS.erpDekker, IDS.erpMara]) {
      expect(stillHeld, `${id} stopped being held for review`).toContain(id);
    }
  });
});
