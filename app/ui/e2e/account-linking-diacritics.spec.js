// @ts-check
//
// A name's letters and a login's letters are not spelled the same way. HR holds
// "Sevgi Doğan"; the directory hands her `adm-sdogan`, an ERP exports her
// colleague as `Danielle Dongen`, a payroll system writes `Ozturk, O.R.` — all
// of them ASCII, because that is what a login and an address can carry. The two
// normalisers reduced a name by *deleting* every character outside `[a-z0-9]`
// instead of folding it, so "Doğan" became `doan` and "Daniëlle" `danille`: the
// letter the two spellings had to agree on was the one letter that disappeared
// from one side only. Every account whose owner's name carries such a letter
// stayed an orphan (#1480).
//
// This spec walks the reporter's own path against the live deployment:
//
//   1. Admin → Account Linking → Run now,
//   2. Identities → her detail page → Linked Accounts: `adm-sdogan…` is THERE,
//      which is the acceptance criterion — `'none'` before the fold, `initial`
//      after it,
//   3. the Orphaned Accounts report no longer lists it,
//   4. the login side folds too, so a directory that DOES spell the letter keeps
//      reaching the same person: one normaliser, both sides, and a name that
//      already matched cannot stop matching,
//   5. an ASCII-spelled account name is a FULL name match on the diacritic
//      identity name again, not the surname-plus-initial it degraded to — read
//      off the link's own stored signals, since the degraded match still scraped
//      over the bar and an analyst could not tell the two apart,
//   6. "Surname, Initials" folds the same way (#1455): the initials module
//      carries its own copy of the strip, and left unfolded it reads Ömer's
//      initial as `m` and rules out the very person the folded name matches,
//   7. the designed collision: two people a fold brings together — a Møller and
//      a Moller — are the namesake case, so their shared login is held for
//      review with the rival named rather than handed to whichever scored first,
//   8. the control: folding must widen who a login can name, never make it name
//      somebody at random, so a folded login nobody answers to is still
//      attributed to nobody,
//   9. a second run detaches nothing, so a link made through the fold converges
//      instead of churning the account's history.
//
// (2), (3), (5), (6), (7) and (9) are what a unit test cannot assert: they read
// the stored links, their signals and the report back through the API, and (9)
// runs the engine twice against one database. The retroactive cleanup re-judges
// every name-only link, and all of these rest on a name — so a cleanup that
// folded differently from the matcher would detach exactly the links this fix
// creates, green in every mocked test and visible only here.
//
// Seeded through the ingest API under a system of its own with a per-run name
// token. The demo dataset's realism slice does carry one diacritic staffer
// (Sevgi Doğan with an `adm-sdogan` login — see
// `test/demo-dataset/parts/DemoRealismPeople.ps1`), but it is opt-in and the
// standard slice has no person name with a diacritic at all, so the fixture is
// seeded here rather than assumed.
//
// Every ASCII spelling below is written out by hand rather than computed, so the
// spec never asserts the code under test against itself.
//
// The run is a real POST, so this spec changes deployment state — it links
// accounts the same way the post-crawl auto-run does. That is deliberate: a
// dry-run would not prove the writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, letterToken, withLinkingFixture, runAccountLinkingFromAdmin, latestCompletedRun,
  linkedAccountNames, linkedPrincipalIds, linkedAccountsPanel, orphanReport,
  signalWeight, memberFor, heldMatchFor, heldPrincipalIds,
} from './accountLinkingSeed';

/** The issue this spec replays, which names the throwaway connector and system. */
const ISSUE = '1480';
const TOKEN = letterToken();
const DOMAIN = `e2e-${ISSUE}.example`;

// One surname stem per case, unique to this run, so no case can be answered by
// another's fixture and the tenant's own people stay out of these assertions.
// Where a case needs both spellings of a name, the ASCII one is spelled out: a
// twin derived by calling the fold would make the fold assert itself.
const STEMS = {
  dogan: `Doğanz${TOKEN}`,            // ğ — the acceptance criterion
  doganAscii: `Doganz${TOKEN}`,
  dongen: `Dongenz${TOKEN}`,          // an ASCII ERP spelling of a diacritic given name
  ozturk: `Öztürkz${TOKEN}`,          // ö + ü, and a dotted Ö as an initial
  ozturkAscii: `Ozturkz${TOKEN}`,
  mollerDia: `Møllerz${TOKEN}`,       // ø — the designed collision, two families
  mollerAscii: `Mollerz${TOKEN}`,
  grossmann: `Grossmannz${TOKEN}`,    // the control: folds to a name nobody has
};

const IDS = {
  sevgi: randomUUID(),
  danielle: randomUUID(),
  omer: randomUUID(),
  miaDia: randomUUID(),
  miaAscii: randomUUID(),
  // The accounts.
  admSevgiAscii: randomUUID(),
  admSevgiDia: randomUUID(),
  erpDanielle: randomUUID(),
  erpOmerAscii: randomUUID(),
  erpOmerDia: randomUUID(),
  admMoller: randomUUID(),
  admNobody: randomUUID(),
};

const NAMES = {
  sevgi: `Sevgi ${STEMS.dogan}`,
  danielle: `Daniëlle ${STEMS.dongen}`,
  omer: `Ömer Rüstem ${STEMS.ozturk}`,
  miaDia: `Mia ${STEMS.mollerDia}`,
  miaAscii: `Mia ${STEMS.mollerAscii}`,
};

/** The display name each seeded account shows — which is all it gives away. */
const adminLabel = (n) => `Admin account ${TOKEN}-${n}`;
const SHOWN = {
  admSevgiAscii: adminLabel(1),
  admSevgiDia: adminLabel(2),
  admMoller: adminLabel(3),
  admNobody: adminLabel(4),
  // The ERP accounts have no login to read, so their display name is the whole
  // of their evidence — one ASCII, one carrying the letters.
  erpDanielle: `Danielle ${STEMS.dongen}`,
  erpOmerAscii: `${STEMS.ozturkAscii}, O.R.`,
  erpOmerDia: `${STEMS.ozturk}, Ö.R.`,
};

/**
 * An HR person, with `given` and `surname` passed separately because that is
 * where the letters this spec is about survive: the display name's halves are
 * parsed, but a given half's own words are what every initial past the first is
 * read from, and a surname's particles and hyphens live only in the column.
 *
 * Their mailbox is spelled the way a directory spells an address — ASCII — which
 * is itself part of the fixture: it is never equal to any login below, so no
 * case here is answered by the email or email-prefix signal.
 */
const person = (id, displayName, given, surname, local) => ({
  id,
  displayName,
  givenName: given,
  surname,
  email: `${local}@${DOMAIN}`.toLowerCase(),
  employeeId: `E2E${ISSUE}-${id.slice(0, 8)}`,
  companyName: `E2E #${ISSUE}`,
});

/**
 * A directory or ERP account with no employee id, no name columns and no
 * department: its display name and its login are the only evidence there is. An
 * `employeeId` here would link it at weight 95 and never exercise this path.
 *
 * `local` is omitted for the ERP accounts, which carry no address at all — the
 * shape most ERP and payroll exports have (#1455).
 */
const account = (id, displayName, local) => ({
  id,
  displayName,
  ...(local ? { email: `${local}@${DOMAIN}`.toLowerCase() } : {}),
  principalType: 'User',
  accountEnabled: true,
});

const IDENTITIES = [
  // The acceptance criterion. Her address is already ASCII, so only the NAME
  // side carries the ğ her admin login has to be folded onto.
  person(IDS.sevgi, NAMES.sevgi, 'Sevgi', STEMS.dogan, `sevgi.${STEMS.doganAscii}`),
  // The ERP case: the diacritic is in the GIVEN name, and the account spells it
  // without. Unfolded this degraded a full-name match to surname-plus-initial.
  person(IDS.danielle, NAMES.danielle, 'Daniëlle', STEMS.dongen, `danielle.${STEMS.dongen}`),
  // "Surname, Initials": his surname carries two letters and his first given
  // name starts with one, which is what the initials module has to fold too.
  person(IDS.omer, NAMES.omer, 'Ömer Rüstem', STEMS.ozturk, `omer.${STEMS.ozturkAscii}`),
  // The collision the fold creates on purpose: two different families whose
  // logins are one word once ø folds to o.
  person(IDS.miaDia, NAMES.miaDia, 'Mia', STEMS.mollerDia, `mia.${STEMS.mollerDia}`),
  person(IDS.miaAscii, NAMES.miaAscii, 'Mia', STEMS.mollerAscii, `mia.b.${STEMS.mollerAscii}`),
];

const ACCOUNTS = [
  // The reported account: initial + surname, spelled the way a directory spells
  // it. Her own forms carried `sdoanz…`, so this matched nothing at all.
  account(IDS.admSevgiAscii, SHOWN.admSevgiAscii, `adm-s${STEMS.doganAscii}`),
  // The same login as a directory that keeps the letter writes it. Both sides
  // fold, so this has to reach her too.
  account(IDS.admSevgiDia, SHOWN.admSevgiDia, `adm-s${STEMS.dogan}`),
  // An ERP export of her colleague's name, ASCII, and nothing else.
  account(IDS.erpDanielle, SHOWN.erpDanielle),
  // The same source's two spellings of one "Surname, Initials" name.
  account(IDS.erpOmerAscii, SHOWN.erpOmerAscii),
  account(IDS.erpOmerDia, SHOWN.erpOmerDia),
  // One login, two families: contested, so held for review.
  account(IDS.admMoller, SHOWN.admMoller, `adm-m${STEMS.mollerAscii}`),
  // The control: folds cleanly, and names nobody in this tenant.
  account(IDS.admNobody, SHOWN.admNobody, `adm-q${STEMS.grossmann}`),
];

const FIXTURE = { issue: ISSUE, token: TOKEN, identities: IDENTITIES, accounts: ACCOUNTS };

/**
 * Why this deployment cannot be asked whether a folded name places an account,
 * or `''` when it can.
 *
 * The fixture rests on the shipped ladder: that admin and plain extra accounts
 * are linked at all, that a name alone may place one, that the three rungs these
 * cases land on are switched on, and that the certainty slider sits at or below
 * what each of them scores with the uniqueness the guard adds. None of that is
 * the fold under test, so a tenant that retuned it skips rather than fails — and
 * is told which part of it was.
 */
function foldedNameLinkingBlocker(rules) {
  for (const type of ['Admin', 'Secondary']) {
    if (!(rules?.onlyLinkTypes || []).includes(type)) return `this deployment does not link ${type} accounts`;
  }
  if (rules?.allowNameOnlyLinks === false) return 'this deployment never links on a name alone';
  for (const name of ['loginNameForm', 'fullName', 'surnameInitials', 'nameUnique']) {
    if (!signalWeight(rules, name)) return `the active dictionary has ${name} switched off`;
  }
  const unique = signalWeight(rules, 'nameUnique');
  const threshold = rules?.linkThreshold ?? 0;
  for (const rung of ['loginNameForm', 'fullName', 'surnameInitials']) {
    if (threshold > signalWeight(rules, rung) + unique) {
      return `the certainty slider (${threshold}) sits above a unique ${rung} match `
        + `(${signalWeight(rules, rung) + unique})`;
    }
  }
  return '';
}

const fx = withLinkingFixture(test, FIXTURE);
let firstRun = null;

test.describe('Account linking — names whose letters a login cannot carry (#1480)', () => {
  test.describe.configure({ mode: 'serial', timeout: 420000 });

  test.beforeEach(() => {
    test.skip(!fx.seeded?.ok, `could not seed through the ingest API (SQL mode required): ${fx.seeded?.reason}`);
    const blocker = foldedNameLinkingBlocker(fx.rules);
    test.skip(!!blocker, `this deployment would not place a folded-name match — ${blocker}`);
  });

  test('an ASCII admin login lands on the diacritic name it spells, through the UI', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);
    firstRun = await latestCompletedRun();
    expect(firstRun?.status).toBe('completed');

    // The acceptance criterion. Her name reduced to `sdoanz…` while the login
    // kept its `g`, so this account matched no form, reached no candidate, and
    // sat in Orphaned Accounts for ever.
    expect(await linkedPrincipalIds(IDS.sevgi)).toContain(IDS.admSevgiAscii);

    // And it rests on the login being read as her name — not on her address,
    // which this login is not, and which would say nothing about the fold.
    const link = await memberFor(IDS.sevgi, IDS.admSevgiAscii);
    expect(link.linkSignals.split(',')).toEqual(['loginNameForm', 'nameUnique']);
    expect(link.linkConfidence)
      .toBe(signalWeight(fx.rules, 'loginNameForm') + signalWeight(fx.rules, 'nameUnique'));

    // Through the identity page, which is where the reporter looked.
    await page.goto(`${BASE}/#identity:${IDS.sevgi}`);
    const panel = await linkedAccountsPanel(page);
    await expect(panel.getByRole('button', { name: SHOWN.admSevgiAscii, exact: true }))
      .toBeVisible({ timeout: 15000 });
  });

  test('and the login side folds too, so the letter-for-letter spelling still reaches her', async () => {
    // One normaliser, both sides. A fold applied to the name only would move her
    // forms away from a directory that does spell the letter, so a login that
    // already matched would stop — which is worse than not folding at all.
    expect(await linkedPrincipalIds(IDS.sevgi)).toContain(IDS.admSevgiDia);
  });

  test('an ASCII-spelled account name is a FULL name match again, not a degraded one', async () => {
    // `Danielle` against `Daniëlle`: unfolded, the two given names simply differ
    // and the match dropped to surname-plus-initial. That still scraped over the
    // bar with the uniqueness evidence beside it, so the symptom here is not an
    // absent link but a wrong one — a reviewable low-confidence match where the
    // evidence is in fact a complete name. The stored signals are the only place
    // an analyst could see the difference.
    expect(await linkedPrincipalIds(IDS.danielle)).toContain(IDS.erpDanielle);

    const link = await memberFor(IDS.danielle, IDS.erpDanielle);
    expect(link.linkSignals.split(',')).toEqual(['fullName', 'nameUnique']);
    expect(link.linkConfidence)
      .toBe(signalWeight(fx.rules, 'fullName') + signalWeight(fx.rules, 'nameUnique'));
  });

  test('a "Surname, Initials" export folds its surname and its initials alike', async () => {
    // Both spellings of one ERP name reach him. The initials module carries its
    // own copy of the ASCII strip: unfolded, `Ömer Rüstem` states `m`, `r` — the
    // Ö deleted and the `m` behind it read as the initial — so the initials
    // signal would contradict the folded name and rule out the one person it
    // matches.
    const linked = await linkedPrincipalIds(IDS.omer);
    expect(linked).toContain(IDS.erpOmerAscii);
    expect(linked).toContain(IDS.erpOmerDia);

    const link = await memberFor(IDS.omer, IDS.erpOmerAscii);
    expect(link.linkSignals.split(',')).toEqual(['surnameInitials', 'nameUnique']);
    expect(link.linkConfidence)
      .toBe(signalWeight(fx.rules, 'surnameInitials') + signalWeight(fx.rules, 'nameUnique'));
  });

  test('two people the fold brings together share one login, so it is held for review', async () => {
    // The designed control, and what stops the fold being "treat near-enough as
    // equal": a Møller and a Moller are two families whose logins are one word
    // once ø folds, so nothing in `adm-m<moller>` says which of them it is. That
    // is the namesake case the uniqueness guard already holds back — it must not
    // go to whichever of the two scored first.
    expect(await linkedAccountNames(IDS.miaDia)).toEqual([]);
    expect(await linkedAccountNames(IDS.miaAscii)).toEqual([]);

    const run = firstRun ?? await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.admMoller);
    expect(held, `the run did not report the held match for ${SHOWN.admMoller} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();
    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('loginName');
    expect(held.rivalCount).toBe(1);
    // Both Mias are offered, so the reviewer is sent to the real pair.
    expect([held.identityId, ...held.rivals.map(r => r.identityId)].sort())
      .toEqual([IDS.miaDia, IDS.miaAscii].sort());
  });

  test('a folded login nobody answers to is still attributed to nobody', async () => {
    // The guard on the whole fix: folding must widen who a login can name, never
    // make it name somebody at random. Nobody in this tenant is a Q. Grossmann,
    // so no identity may hold this account and no held match may claim it.
    expect(await heldPrincipalIds()).not.toContain(IDS.admNobody);
    for (const identity of IDENTITIES) {
      expect(await linkedPrincipalIds(identity.id), `${identity.displayName} inherited the login that names nobody`)
        .not.toContain(IDS.admNobody);
    }
  });

  test('the placed accounts are off the Orphaned Accounts report, the contested one is on it', async () => {
    // The half of the symptom an analyst works from: these accounts were listed
    // as outstanding work, on every run, for ever. A link that leaves one on this
    // report has not placed it.
    const outstanding = (await orphanReport()).rows.map(r => r.displayName);
    expect(outstanding).not.toContain(SHOWN.admSevgiAscii);
    expect(outstanding).not.toContain(SHOWN.admSevgiDia);
    expect(outstanding).not.toContain(SHOWN.erpDanielle);
    expect(outstanding).not.toContain(SHOWN.erpOmerAscii);
    expect(outstanding).not.toContain(SHOWN.erpOmerDia);
    // The controls — the contested login and the one naming nobody are genuinely
    // still there, so a report that broke entirely cannot read as a pass.
    expect(outstanding).toContain(SHOWN.admMoller);
    expect(outstanding).toContain(SHOWN.admNobody);
  });

  test('a second run detaches nothing, so a folded-name link does not churn', async ({ page }) => {
    // Convergence, and the half only a live database can show. The cleanup is the
    // only code here that DELETES a link, and it re-judges every name-only link
    // on every run — all five of these. A cleanup that folded differently from
    // the matcher detaches them, the same run re-creates them from the orphan
    // pool, and each account's history churns for ever while every unit test
    // stays green.
    await runAccountLinkingFromAdmin(page);
    const second = await latestCompletedRun();

    expect(second.status).toBe('completed');
    expect(second.linksRemoved, 'the second run re-detached links the first one settled').toBe(0);
    expect(await linkedPrincipalIds(IDS.sevgi)).toContain(IDS.admSevgiAscii);
    expect(await linkedPrincipalIds(IDS.sevgi)).toContain(IDS.admSevgiDia);
    expect(await linkedPrincipalIds(IDS.danielle)).toContain(IDS.erpDanielle);
    expect(await linkedPrincipalIds(IDS.omer)).toContain(IDS.erpOmerAscii);
    // ...and the hold has not quietly become a link either.
    expect(await heldPrincipalIds()).toContain(IDS.admMoller);
    expect(second.nameOnlyMatches).toBe(firstRun?.nameOnlyMatches);
  });
});
