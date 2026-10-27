// @ts-check
//
// An admin login spells its owner's name, but a provisioning convention does not
// spell the whole of it. #1454 taught the dictionary to read `adm-fhogenbirk` as
// "the F. Hogenbirk of this tenant" — initial + the surname written whole,
// particles and all. Three shapes a real tenant hands out are not that, and
// matched no form at all:
//
//   adm-ddongen    the particles dropped — Daniëlle van Dongen
//   adm-wvelde     one half of a hyphenated double surname — W. van der Velde-Bierma
//   adm-svisser2   a trailing digit run numbering a namesake's login
//
// A login that matches no form reaches no candidate, so its owner was not merely
// mis-ranked — the account was invisible to the run: not linked, and not even
// held for review with a name to check. The reporter measured 0 of 8
// particle-dropped and 0 of 2 half-double-surname accounts placed (#1468).
//
// This spec walks that path against the live deployment:
//
//   1. Admin → Account Linking → Run now,
//   2. Identities → the owner's detail page → Linked Accounts: each of the three
//      reduced logins is THERE, which is the regression,
//   3. the Orphaned Accounts report no longer lists them,
//   4. the grading case: a person genuinely called the reduced name outranks the
//      person whose name a convention reduced to it, so `adm-d<surname>` goes to
//      the D. Akker of the tenant and not to the Dana van Akker beside her. Read
//      as one level the two would tie and neither could be placed (#1460) —
//      which is why this is the assertion that stops the fix from being "match
//      anything that looks close",
//   5. a numbered login two namesakes answer to links to neither and is held for
//      review with its rival named — the account is contested, which is the
//      visible-and-reviewable outcome the symptom denied it,
//   6. the control: a reduced login nobody in the directory answers to is still
//      attributed to nobody,
//   7. a second run detaches nothing, so a link made on a reduced login
//      converges instead of churning the account's history.
//
// Reading shorter spellings widens who a login can name, and the first
// measurement of it on the reporting dataset found the widening doing three
// things nobody asked for. Those are the remaining cases, one per rule:
//
//   8.  a reduced form must not rival a full-name match. A personal account the
//       directory spells `Melanie Schipper-Siemons` stayed held while a Michelle
//       Schipper answered to the `m.schipper` it logs in as — five correct links
//       lost to a claim carrying one letter of a given name,
//   9.  a numbered login must never land on the owner of the un-numbered form.
//       `p.h.nanhoe2` was attributed to the Priya Nanhoe whose own mailbox is
//       `p.h.nanhoe`, which is the one Priya the number says it is not,
//   10. an admin login numbered away from the only person who answers to it is
//       held for review rather than linked — and says the number is why,
//   11. a half-of-a-double-surname login offers its owner. `adm-a<becker>` is
//       contested by the two plain Beckers spelled it outright, and the hold
//       listed only them while the Andrea Neumann-Becker it belongs to was
//       offered nowhere.
//
// (2), (3), (5), (7), (9), (10) and (11) are what a unit test cannot assert:
// they read the stored links, the held-for-review list and the report back
// through the API, and (7) runs the engine twice against one database. The
// retroactive cleanup judges name-only links and a login is name-class evidence,
// so a cleanup that cannot spell a reduced login back to a name detaches exactly
// the links this fix creates — green in every mocked test, visible only here.
//
// Seeded through the ingest API under a system of its own with a per-run name
// token: the demo dataset builds every admin login in a shape the engine already
// read (`test/unit/DemoRealism.Tests.ps1` pins the seed to plain `adm-<initial>
// <surname>` for exactly that reason), so none of these three shapes is in it.
//
// The run is a real POST, so this spec changes deployment state — it links
// accounts the same way the post-crawl auto-run does. That is deliberate: a
// dry-run would not prove the writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, letterToken, loginOnlyLinkingBlocker, runAccountLinkingFromAdmin, latestCompletedRun,
  linkedAccountNames, linkedPrincipalIds, linkedAccountsPanel, orphanReport, withLinkingFixture,
} from './accountLinkingSeed';

/** The issue this spec replays, which names the throwaway connector and system. */
const ISSUE = '1468';

// Letters only, which matters more here than anywhere: this spec's whole point
// includes the numbered-login cases, so a surname that ended in a digit run
// would make them pass on the surname instead of on the number. See
// `letterToken`.
const TOKEN = letterToken();
const DOMAIN = 'e2e-1468.example';

// One surname stem per case, so no case can be answered by another's fixture.
// Each stem is unique to this run, which is what keeps the tenant's own people
// (and the demo dataset's Vissers and van Dongens) out of these assertions.
const STEMS = {
  dongen: `Dongenz${TOKEN}`,   // particles dropped: `van Dongenz…` → `ddongenz…`
  velde: `Veldez${TOKEN}`,     // half a double surname: `van der Veldez…-Biermaz…`
  bierma: `Biermaz${TOKEN}`,
  visser: `Visserz${TOKEN}`,   // numbered login over two namesakes
  timmerman: `Timmermanz${TOKEN}`, // numbered login over one owner
  akker: `Akkerz${TOKEN}`,     // the grading case: `van Akkerz…` beside `Akkerz…`
  schipper: `Schipperz${TOKEN}`, // half a double surname, and somebody's whole one
  siemons: `Siemonsz${TOKEN}`,
  nanhoe: `Nanhoez${TOKEN}`,   // a numbered login over the un-numbered form's owner
  kleef: `Kleefz${TOKEN}`,     // the same, where the login is the only evidence
  becker: `Beckerz${TOKEN}`,   // a half form two people are spelled outright
  neumann: `Neumannz${TOKEN}`,
};

const IDS = {
  danielle: randomUUID(),
  wilma: randomUUID(),
  sanneA: randomUUID(),
  sanneB: randomUUID(),
  teun: randomUUID(),
  dana: randomUUID(),
  dirkje: randomUUID(),
  melanie: randomUUID(),
  michelle: randomUUID(),
  priyaOwner: randomUUID(),
  priyaSecond: randomUUID(),
  priyaThird: randomUUID(),
  sophie: randomUUID(),
  neumannBecker: randomUUID(),
  andrea: randomUUID(),
  andreas: randomUUID(),
  admDongen: randomUUID(),
  admVelde: randomUUID(),
  admVisser: randomUUID(),
  admTimmerman: randomUUID(),
  admAkker: randomUUID(),
  admNobody: randomUUID(),
  admKleef: randomUUID(),
  admBecker: randomUUID(),
  ownMelanie: randomUUID(),
  ownPriya: randomUUID(),
};

const NAMES = {
  danielle: `Daniëlle van ${STEMS.dongen}`,
  wilma: `Wilma van der ${STEMS.velde}-${STEMS.bierma}`,
  sanneA: `Sanne ${STEMS.visser}`,
  sanneB: `Sanne ${STEMS.visser}`,
  teun: `Teun ${STEMS.timmerman}`,
  dana: `Dana van ${STEMS.akker}`,
  dirkje: `Dirkje ${STEMS.akker}`,
  melanie: `Melanie ${STEMS.schipper}-${STEMS.siemons}`,
  michelle: `Michelle ${STEMS.schipper}`,
  // Three people spelled one name; only `priyaOwner` holds the un-numbered address.
  priya: `Priya ${STEMS.nanhoe}`,
  sophie: `Sophie van ${STEMS.kleef}`,
  neumannBecker: `Andrea ${STEMS.neumann}-${STEMS.becker}`,
  andrea: `Andrea ${STEMS.becker}`,
  andreas: `Andreas ${STEMS.becker}`,
};

/** The display name every seeded admin account carries — see `account`. */
const adminLabel = (n) => `Admin account ${TOKEN}-${n}`;
const ADMIN_NAMES = {
  admDongen: adminLabel(1),
  admVelde: adminLabel(2),
  admVisser: adminLabel(3),
  admTimmerman: adminLabel(4),
  admAkker: adminLabel(5),
  admNobody: adminLabel(6),
  admKleef: adminLabel(7),
  admBecker: adminLabel(8),
};

/**
 * An HR person. `given` and `surname` are passed separately because the whole
 * point of these fixtures is the surname's own shape — the particles and the
 * hyphen the login drops — which only survives in the structured column.
 *
 * Their mailbox spells their name in full, as a personal mailbox does, and so is
 * never the login a case below is about.
 */
const person = (id, displayName, given, surname, local) => ({
  id,
  displayName,
  givenName: given,
  surname,
  email: `${local}@${DOMAIN}`.toLowerCase(),
  employeeId: `E2E1468-${id.slice(0, 8)}`,
  companyName: 'E2E #1468',
});

/**
 * A directory account holding no employee id, no name columns and no department,
 * so the only evidence it carries is its display name and its login — exactly
 * like the accounts in the report. An `employeeId` here would link it at weight
 * 95 and never exercise this path at all.
 *
 * The admin fixtures pass a display name that is nobody's name (`Admin account
 * …-3`), which leaves the login as the only evidence there is. The personal ones
 * pass the owner's own name, which is the other half of the shape the full-name
 * cases are about: a login read as a rival of it is what held them back.
 */
const account = (id, displayName, local) => ({
  id, displayName, email: `${local}@${DOMAIN}`.toLowerCase(),
  principalType: 'User', accountEnabled: true,
});

const IDENTITIES = [
  person(IDS.danielle, NAMES.danielle, 'Daniëlle', `van ${STEMS.dongen}`, `danielle.van${STEMS.dongen}`),
  person(IDS.wilma, NAMES.wilma, 'Wilma', `van der ${STEMS.velde}-${STEMS.bierma}`,
    `wilma.vander${STEMS.velde}`),
  // Two people spelled the same name, which is what a numbered login numbers.
  person(IDS.sanneA, NAMES.sanneA, 'Sanne', STEMS.visser, `sanne.a.${STEMS.visser}`),
  person(IDS.sanneB, NAMES.sanneB, 'Sanne', STEMS.visser, `sanne.b.${STEMS.visser}`),
  person(IDS.teun, NAMES.teun, 'Teun', STEMS.timmerman, `teun.${STEMS.timmerman}`),
  // The grading pair: one woman's surname reduces to the other's whole surname.
  person(IDS.dana, NAMES.dana, 'Dana', `van ${STEMS.akker}`, `dana.van${STEMS.akker}`),
  person(IDS.dirkje, NAMES.dirkje, 'Dirkje', STEMS.akker, `dirkje.${STEMS.akker}`),
  // The full-name pair: `m<schipper>` is half of Melanie's surname and the whole
  // of Michelle's, so Michelle answers to it one level above Melanie.
  person(IDS.melanie, NAMES.melanie, 'Melanie', `${STEMS.schipper}-${STEMS.siemons}`,
    `melanie.${STEMS.schipper}${STEMS.siemons}`),
  person(IDS.michelle, NAMES.michelle, 'Michelle', STEMS.schipper, `michelle.${STEMS.schipper}`),
  // Three Priyas. Only the first holds `p.h.<nanhoe>` — the address the numbered
  // account below is numbered away from.
  person(IDS.priyaOwner, NAMES.priya, 'Priya', STEMS.nanhoe, `p.h.${STEMS.nanhoe}`),
  person(IDS.priyaSecond, NAMES.priya, 'Priya', STEMS.nanhoe, `p.${STEMS.nanhoe}`),
  person(IDS.priyaThird, NAMES.priya, 'Priya', STEMS.nanhoe, `priya.${STEMS.nanhoe}`),
  // Her own mailbox IS the reduced form, so a login numbering it is not hers.
  person(IDS.sophie, NAMES.sophie, 'Sophie', `van ${STEMS.kleef}`, `s${STEMS.kleef}`),
  // The half-form trio: two people are spelled `a<becker>` outright, and the
  // owner of the double surname it is half of answers to it only reduced.
  person(IDS.neumannBecker, NAMES.neumannBecker, 'Andrea', `${STEMS.neumann}-${STEMS.becker}`,
    `andrea.${STEMS.neumann}${STEMS.becker}`),
  person(IDS.andrea, NAMES.andrea, 'Andrea', STEMS.becker, `andrea.${STEMS.becker}`),
  person(IDS.andreas, NAMES.andreas, 'Andreas', STEMS.becker, `andreas.${STEMS.becker}`),
];

const ACCOUNTS = [
  // The particles dropped. Her own forms write them: `dvan<dongen>`.
  account(IDS.admDongen, ADMIN_NAMES.admDongen, `adm-d${STEMS.dongen}`),
  // One half of the double surname. Her only form writes it whole.
  account(IDS.admVelde, ADMIN_NAMES.admVelde, `adm-w${STEMS.velde}`),
  // A numbered login over two namesakes — contested, so held for review.
  account(IDS.admVisser, ADMIN_NAMES.admVisser, `adm-s${STEMS.visser}2`),
  // A numbered login over one owner — placed, on the name the number numbers.
  account(IDS.admTimmerman, ADMIN_NAMES.admTimmerman, `adm-t${STEMS.timmerman}4`),
  // Reduces to Dana's surname and spells Dirkje's whole one: Dirkje's.
  account(IDS.admAkker, ADMIN_NAMES.admAkker, `adm-d${STEMS.akker}`),
  // The control: reduced in the same way, after nobody in the directory.
  account(IDS.admNobody, ADMIN_NAMES.admNobody, `adm-dstraatenz${TOKEN}`),
  // Numbered away from the only person who answers to it: her own mailbox is
  // `s<kleef>`, so `adm-s<kleef>2` is some other S. Kleef's — held, not linked.
  account(IDS.admKleef, ADMIN_NAMES.admKleef, `adm-s${STEMS.kleef}2`),
  // Half of Andrea Neumann-Becker's double surname, and the whole spelling of
  // two other people's: contested, and the hold must still offer her.
  account(IDS.admBecker, ADMIN_NAMES.admBecker, `adm-a${STEMS.becker}`),
  // Melanie's own account: her full name in the directory, half her surname in
  // the login. Michelle answers to that login; she must not rival the name.
  account(IDS.ownMelanie, NAMES.melanie, `m.${STEMS.schipper}`),
  // A numbered personal account over three namesakes, one of whom holds the
  // un-numbered address — the one Priya it demonstrably is not.
  account(IDS.ownPriya, NAMES.priya, `p.h.${STEMS.nanhoe}2`),
];

/** The fixture, and the two things about the deployment it needs to be true. */
const FIXTURE = { issue: ISSUE, token: TOKEN, identities: IDENTITIES, accounts: ACCOUNTS };
const fx = withLinkingFixture(test, FIXTURE);
let firstRun = null;

test.describe('Account linking — logins a convention writes shorter than the name (#1468)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(!fx.seeded?.ok, `could not seed through the ingest API (SQL mode required): ${fx.seeded?.reason}`);
    // All six accounts here rest on their login alone, so a deployment that
    // would not place one on a login holds them back for reasons that are not
    // this bug.
    const blocker = loginOnlyLinkingBlocker(fx.rules);
    test.skip(!!blocker, `this deployment would not link on a login alone — ${blocker}`);
  });

  test('a login that drops the surname particles lands on its owner, through the UI', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);
    firstRun = await latestCompletedRun();

    // The regression. Her forms write the particles (`dvan<dongen>`), so before
    // the fix this login matched nothing and reached no candidate at all.
    expect(await linkedPrincipalIds(IDS.danielle)).toContain(IDS.admDongen);

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.danielle}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: ADMIN_NAMES.admDongen, exact: true }))
      .toBeVisible({ timeout: 15000 });
  });

  test('a login reduced to one half of a double surname lands on its owner', async () => {
    expect(await linkedPrincipalIds(IDS.wilma)).toContain(IDS.admVelde);
  });

  test('a numbered login lands on the owner of the name it numbers', async () => {
    // The digits number a namesake's login; they are no part of anybody's name.
    expect(await linkedPrincipalIds(IDS.teun)).toContain(IDS.admTimmerman);
  });

  test('and none of the three is in the Orphaned Accounts report any more', async () => {
    // The other half of the reported symptom: the accounts stayed outstanding
    // analyst work. A link that does not clear them off this report has not
    // actually placed them.
    const names = (await orphanReport()).rows.map(r => r.displayName);
    expect(names).not.toContain(ADMIN_NAMES.admDongen);
    expect(names).not.toContain(ADMIN_NAMES.admVelde);
    expect(names).not.toContain(ADMIN_NAMES.admTimmerman);
    // The controls — the contested ones, the numbered-away one and the one naming
    // nobody are genuinely still there, so a report that broke entirely cannot
    // read as a pass.
    expect(names).toContain(ADMIN_NAMES.admVisser);
    expect(names).toContain(ADMIN_NAMES.admNobody);
    expect(names).toContain(ADMIN_NAMES.admKleef);
    expect(names).toContain(ADMIN_NAMES.admBecker);
  });

  test('the person actually called the reduced name outranks the one reduced to it', async () => {
    // What stops this fix reducing to "whoever looks closest wins". `adm-d<akker>`
    // writes Dirkje's whole surname and Dana's with its particle dropped — both
    // score the same single login signal, so the grade is the only thing that can
    // separate them. Read at one level they tie and NEITHER is placed (#1460).
    expect(await linkedPrincipalIds(IDS.dirkje)).toContain(IDS.admAkker);
    expect(await linkedAccountNames(IDS.dana)).toEqual([]);
  });

  test('a numbered login two namesakes answer to links to neither, and names its rival', async () => {
    // Being contested is the outcome the symptom denied this account: a login
    // matching no form made its owner invisible, so there was nothing to review.
    expect(await linkedAccountNames(IDS.sanneA)).toEqual([]);
    expect(await linkedAccountNames(IDS.sanneB)).toEqual([]);

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.admVisser);
    expect(held, `the run did not report the held match for ${ADMIN_NAMES.admVisser} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('loginName');
    expect(held.rivalCount).toBe(1);
    // The rival is the OTHER Sanne, so the reviewer is sent to a real namesake.
    expect(held.identityId === IDS.sanneA || held.identityId === IDS.sanneB).toBe(true);
    expect(held.rivals.map(r => r.identityId)).toEqual([
      held.identityId === IDS.sanneA ? IDS.sanneB : IDS.sanneA,
    ]);
  });

  test('a reduced login nobody answers to is still attributed to nobody', async () => {
    // The guard on the whole fix: reading a shorter spelling must widen who a
    // login can name, never make it name somebody at random. Nobody in this
    // tenant reduces to `dstraatenz…`, so no identity may hold this account and
    // no held match may claim it either.
    const run = firstRun ?? await latestCompletedRun();
    expect((run?.nameOnlySuggestions ?? []).map(s => s.principalId)).not.toContain(IDS.admNobody);
    for (const id of Object.values(IDS)) {
      if (!IDENTITIES.some(i => i.id === id)) continue;
      expect(await linkedPrincipalIds(id), `${id} inherited the login that names nobody`)
        .not.toContain(IDS.admNobody);
    }
  });

  test('a reduced form does not rival the full name the account is spelled with', async ({ page }) => {
    // The measured regression of reading shorter spellings: Melanie's own account
    // carries her name in full, and `m<schipper>` — half her surname — is also the
    // whole of Michelle Schipper's. Counted as a rival, the correct full-name link
    // was held instead of made, five times over on the reporting dataset.
    expect(await linkedPrincipalIds(IDS.melanie)).toContain(IDS.ownMelanie);
    // ...and not on Michelle, who answers only to the login.
    expect(await linkedPrincipalIds(IDS.michelle)).not.toContain(IDS.ownMelanie);

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.melanie}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: NAMES.melanie, exact: true }))
      .toBeVisible({ timeout: 15000 });
  });

  test('a numbered account is never given to the owner of the un-numbered address', async () => {
    // `p.h.<nanhoe>2` beside the `p.h.<nanhoe>` mailbox: the login singled its owner
    // out on her own address and overrode a display name three people are spelled,
    // so the account went to the one Priya the number says it is not. Held now, with
    // the other two offered — the reviewer's real choice.
    for (const id of [IDS.priyaOwner, IDS.priyaSecond, IDS.priyaThird]) {
      expect(await linkedPrincipalIds(id), `${id} was given the numbered account`)
        .not.toContain(IDS.ownPriya);
    }

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.ownPriya);
    expect(held, `the run did not report the held match for ${NAMES.priya} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('full');
    expect(held.rivalCount).toBe(2);
  });

  test('an admin login the number rules everybody out of is held, and says so', async () => {
    // Sophie's own mailbox IS `s<kleef>`, so `adm-s<kleef>2` is some other
    // S. Kleef's and nobody else in this tenant answers to the form. Scored, so the
    // account is reviewable rather than invisible — and reported with its own
    // reason, since calling it an ambiguity would send the reviewer after a
    // namesake who does not exist.
    expect(await linkedAccountNames(IDS.sophie)).toEqual([]);

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.admKleef);
    expect(held, `the run did not report the held match for ${ADMIN_NAMES.admKleef} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('numberedLogin');
    expect(held.identityId).toBe(IDS.sophie);
    expect(held.rivalCount).toBe(0);
  });

  test('a half-of-a-double-surname login offers the owner of that surname', async () => {
    // `adm-a<becker>` is spelled outright by two plain Beckers, so it is rightly
    // contested — but the hold named only them, and the Andrea Neumann-Becker whose
    // double surname it is half of was offered nowhere. A reviewer handed everybody
    // except the owner cannot resolve the account at all.
    for (const id of [IDS.neumannBecker, IDS.andrea, IDS.andreas]) {
      expect(await linkedPrincipalIds(id), `${id} was given the contested half-form login`)
        .not.toContain(IDS.admBecker);
    }

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.admBecker);
    expect(held, `the run did not report the held match for ${ADMIN_NAMES.admBecker} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect([held.identityId, ...held.rivals.map(r => r.identityId)].sort())
      .toEqual([IDS.neumannBecker, IDS.andrea, IDS.andreas].sort());
  });

  test('a second run detaches nothing and leaves the accounts where it put them', async ({ page }) => {
    // Convergence, and the half only a live database can show. The run's
    // retroactive cleanup judges every name-only link, and a login is name-class
    // evidence — so a cleanup that cannot spell a reduced login back to a name
    // sees a link resting on a name that points at nobody, detaches it,
    // re-creates it from the orphan pool in the same run, and churns the
    // account's history for ever.
    await runAccountLinkingFromAdmin(page);
    const second = await latestCompletedRun();

    expect(second.status).toBe('completed');
    expect(second.linksRemoved, 'the second run re-detached links the first one settled').toBe(0);
    expect(await linkedPrincipalIds(IDS.danielle)).toContain(IDS.admDongen);
    expect(await linkedPrincipalIds(IDS.wilma)).toContain(IDS.admVelde);
    expect(await linkedPrincipalIds(IDS.teun)).toContain(IDS.admTimmerman);
    expect(await linkedPrincipalIds(IDS.dirkje)).toContain(IDS.admAkker);
    // The full-name link beside a reduced login converges too: its evidence is a
    // name, so the cleanup re-judges it on every run.
    expect(await linkedPrincipalIds(IDS.melanie)).toContain(IDS.ownMelanie);
    expect(second.nameOnlyMatches).toBe(firstRun?.nameOnlyMatches);
  });
});
