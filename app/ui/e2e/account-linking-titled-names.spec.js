// @ts-check
/**
 * Account Linking does not attach an account to a namesake because the owner's
 * HR display name carries a title or a particle surname (#1439).
 *
 * Reported symptom, walked here end to end: an orphan account named
 * "Jan de Vries" showed up under the *untitled* namesake's Linked Accounts,
 * while the person it belongs to — "Jan de Vries MSc" in HR — showed none. The
 * name parser read the first word of the display name as the given name and the
 * LAST as the surname, so a title became the surname ("msc") and a particle
 * surname lost its particles ("van den Berg" → "berg"). The owner was indexed
 * under a name nobody has, stopped being a candidate for her own account, and
 * the account went to whoever still spelled the same.
 *
 * Five families are seeded, each a different face of the same defect, and all
 * five are decided by ONE linking run:
 *
 *   A  titled owner, no namesake   → her account must land on HER
 *                                    (before the fix: linked to nobody)
 *   B  titled owner + untitled     → a genuine tie, so the account must land on
 *      namesake                      NEITHER and go to review
 *                                    (before the fix: confidently the namesake)
 *   C  "Bakker-van der Hoeve"      → two different families; the account must
 *      vs "van der Hoeve"            land on neither
 *                                    (before the fix: the last word matched)
 *   D  birth surname in the HR     → her account, which carries the name in use,
 *      column, name in use in the    must land on HER, and not be blocked by the
 *      display name + a namesake     namesake who shares only the birth surname
 *      on the birth surname          (the first fix read the columns INSTEAD of
 *                                    the display name and left her unlinked)
 *   E  one person called the name, → the plain account must land on the person
 *      a second who carries it as    CALLED that, and her own account on the
 *      her birth surname only        other one
 *                                    (indexing the birth name made this a tie,
 *                                    which is a link main would have made)
 *
 * A, D and E are what make B and C meaningful: they prove the run actually
 * linked something, so "no link" in B and C is a decision and not a run that
 * did nothing.
 *
 * Dataset-independent. Everything it asserts over, it seeds itself through the
 * ingest API under a system of its own and a per-run name token, so it runs
 * against the demo dataset and a real tenant alike, and removes its own rows
 * afterwards. It does trigger a real linking run, which is the reporter's path
 * and the deployment's own idempotent admin action.
 */

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  API, openIngestSession, closeIngestSession, runAccountLinkingFromAdmin,
  linkedAccountNames, linkedAccountsPanel,
} from './accountLinkingSeed';

// A token that makes every seeded surname unique to this run, so the spec can
// never match a real person and two concurrent runs can't see each other.
// Lower-case alphanumerics only: the name parser folds everything else away.
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);

/** The four families, as the HR source and the accounts spell them. */
const FAMILIES = {
  // Particle surname + a post-nominal title, exactly as reported.
  a: { given: 'Jan', surname: `de Vriesz${TOKEN}`, title: 'MSc' },
  // Same shape, plus a real namesake who has no title.
  b: { given: 'Lotte', surname: `van der Steenz${TOKEN}`, title: 'MSc' },
  // A hyphenated compound whose tail is another family's whole surname.
  c: { compound: `Bakker-van der Hoevez${TOKEN}`, plain: `van der Hoevez${TOKEN}`, given: 'Mark' },
  // Born "de Wittz", known as "Bakker-de Wittz": HR holds the birth surname in
  // the column and the name in use in the display name. Plus a different person
  // who is really called by the birth surname.
  d: { given: 'Sanne', birth: `de Wittz${TOKEN}`, inUse: `Bakker-de Wittz${TOKEN}` },
  // Mirror of D, and the account that must NOT become a tie: one person is
  // called "Jansenz", a second is called "de Boerz-Jansenz" and only carries
  // "Jansenz" as the birth surname in her HR column.
  e: { given: 'Fleur', name: `Jansenz${TOKEN}`, other: `de Boerz-Jansenz${TOKEN}` },
};

const plain = (f) => `${f.given} ${f.surname}`;
const titled = (f) => `${f.given} ${f.surname} ${f.title}`;

/** Ids are minted up front so the seed, the assertions and the cleanup agree. */
const IDS = {
  ownerA: randomUUID(), ownerB: randomUUID(), namesakeB: randomUUID(), ownerC: randomUUID(),
  ownerD: randomUUID(), namesakeD: randomUUID(), ownerE: randomUUID(), otherE: randomUUID(),
  orphanA: randomUUID(), orphanB: randomUUID(), orphanC: randomUUID(), orphanD: randomUUID(),
  orphanE: randomUUID(), orphanEOther: randomUUID(),
};

/** State the seed creates and the teardown has to give back. */
const seeded = { session: null, ready: false };

/** An identity as an HR source writes it: free-text display name, clean columns. */
const identity = (id, displayName, given, surname) => ({
  id, displayName, givenName: given, surname,
  email: `${given}.${surname.replace(/[^A-Za-z0-9]/g, '')}.${id.slice(0, 4)}@e2e-1439.example`.toLowerCase(),
  employeeId: `E2E1439-${id.slice(0, 8)}`,
  companyName: 'E2E #1439',
});

/**
 * An account with no address and no employee id, so the name signals are the
 * only evidence there is — which is the condition the defect needed. `extra`
 * carries the name columns for an account provisioned from an HR record.
 */
const orphanAccount = (id, displayName, extra = {}) => ({
  id, displayName, principalType: 'User', accountEnabled: true, ...extra,
});

/**
 * Seed a system, eight HR identities and six orphan accounts. Returns false
 * when the deployment won't allow it (mock mode, or an API key that may not
 * ingest), which is the only reason this spec skips.
 */
async function seed() {
  seeded.session = await openIngestSession({
    displayName: `e2e-1439-${TOKEN}`,
    description: 'Throwaway key for the #1439 account-linking E2E. Removed by the spec.',
    system: { systemType: 'HR', tenantId: `e2e-1439-${TOKEN}`, displayName: `E2E #1439 HR (${TOKEN})` },
  });
  if (!seeded.session.ok) return false;
  const { mustIngest } = seeded.session;

  const { a, b, c, d, e } = FAMILIES;
  await mustIngest('identities', {
    records: [
      // A: the only person of her name, and HR spells her with a title.
      identity(IDS.ownerA, titled(a), a.given, a.surname),
      // B: two real people called the same thing, one of them titled.
      identity(IDS.ownerB, titled(b), b.given, b.surname),
      identity(IDS.namesakeB, plain(b), b.given, b.surname),
      // C: a hyphenated compound surname, no title involved.
      identity(IDS.ownerC, `${c.given} ${c.compound}`, c.given, c.compound),
      // D: display name and column disagree — name in use vs birth surname.
      identity(IDS.ownerD, `${d.given} ${d.inUse}`, d.given, d.birth),
      // ...and someone who really is called by that birth surname.
      identity(IDS.namesakeD, `${d.given} ${d.birth}`, d.given, d.birth),
      // E: one person called "Jansenz" in every column...
      identity(IDS.ownerE, `${e.given} ${e.name}`, e.given, e.name),
      // ...and one who is called "de Boerz-Jansenz" but whose HR record still
      // carries "Jansenz" as her birth surname, which indexes her under it too.
      identity(IDS.otherE, `${e.given} ${e.other}`, e.given, e.name),
    ],
  });

  await mustIngest('principals', {
    records: [
      orphanAccount(IDS.orphanA, plain(a)),
      orphanAccount(IDS.orphanB, plain(b)),
      // C's account spells the OTHER family — it must not be absorbed.
      orphanAccount(IDS.orphanC, `${c.given} ${c.plain}`),
      // D's account carries the name in use in its display name, as the
      // directory has it, and the birth surname in its column, as HR fed it —
      // so it matches BOTH D's owner and the namesake, and only the owner is
      // actually called by the name in use.
      orphanAccount(IDS.orphanD, `${d.given} ${d.inUse}`, { givenName: d.given, surname: d.birth }),
      // E's accounts are plain directory accounts — a display name and nothing
      // else, which is what makes the birth-surname collision a tie. One carries
      // the name only its owner is called by, the other the second person's.
      orphanAccount(IDS.orphanE, `${e.given} ${e.name}`),
      orphanAccount(IDS.orphanEOther, `${e.given} ${e.other}`),
    ],
  });
  return true;
}

/**
 * Give the deployment its rows back: the accounts first, then (in
 * `closeIngestSession`) the identities, the system and the key.
 *
 * A tombstoned account is no longer counted as an orphan (#1442), but the rows
 * do survive the retention window, so they are reclassified as non-human on the
 * way out: that is the one class no human-facing surface reports on, and it
 * keeps six ex-fixtures off a real deployment's reports while they age out.
 */
async function unseed() {
  if (seeded.session?.systemId) {
    await seeded.session.ingest('principals', {
      records: [IDS.orphanA, IDS.orphanB, IDS.orphanC, IDS.orphanD, IDS.orphanE, IDS.orphanEOther]
        .map(id => ({ id, principalType: 'ServicePrincipal' })),
    }).catch(() => {});
    // An empty FULL batch is how a source says "this scope is empty now".
    await seeded.session.ingest('principals', { syncMode: 'full' }).catch(() => {});
  }
  await closeIngestSession(seeded.session, {
    identityIds: [IDS.ownerA, IDS.ownerB, IDS.namesakeB, IDS.ownerC, IDS.ownerD, IDS.namesakeD,
      IDS.ownerE, IDS.otherE],
    systemNote: 'Disabled leftover of the #1439 account-linking E2E.',
  });
}

/** Identities → search → open one, the way the reporter got there. */
async function openIdentityFromList(page, displayName) {
  await page.goto('/#identities');
  const search = page.getByPlaceholder(/Search by name, email/i);
  await expect(search).toBeVisible({ timeout: 15000 });
  await search.fill(displayName);
  await page.getByText(displayName, { exact: true }).first().click();
}

test.describe('Account Linking — titled HR names and particle surnames (#1439)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    let ok = false;
    try { ok = await seed(); } catch { ok = false; }
    if (!ok) await unseed();
    seeded.ready = ok;
  });

  test.afterAll(async () => {
    await unseed();
  });

  test('one run decides all five families correctly', async ({ page }) => {
    if (!seeded.ready) { test.skip(true, 'Could not seed through the ingest API (SQL mode required)'); return; }
    test.setTimeout(240000);

    const { a, b, c, d, e } = FAMILIES;

    // ── The reporter's path: Admin → Account Linking → Run ──────────────
    await runAccountLinkingFromAdmin(page);

    // ── A: the titled owner gets her own account ────────────────────────
    // Through the UI, exactly as reported: Identities → open the person → the
    // orphan account is under her Linked Accounts, not somebody else's.
    await openIdentityFromList(page, titled(a));
    const panelA = await linkedAccountsPanel(page);
    await expect(panelA.getByRole('button', { name: plain(a), exact: true }))
      .toBeVisible({ timeout: 15000 });
    // ...and nothing else crept in.
    expect(await linkedAccountNames(IDS.ownerA)).toEqual([plain(a)]);

    // ── B: a genuine namesake tie goes to review, not to a guess ────────
    // Both people really are called this. Before the fix only the untitled one
    // was ever a candidate, so the account was attached to her with confidence.
    expect(await linkedAccountNames(IDS.namesakeB)).not.toContain(plain(b));
    expect(await linkedAccountNames(IDS.ownerB)).not.toContain(plain(b));
    // The namesake's page says so in as many words.
    await page.goto(`/#identity:${IDS.namesakeB}`);
    const panelB = await linkedAccountsPanel(page);
    await expect(panelB.getByText('No linked accounts.')).toBeVisible({ timeout: 15000 });

    // ── C: two families that share a surname tail stay apart ────────────
    expect(await linkedAccountNames(IDS.ownerC)).not.toContain(`${c.given} ${c.plain}`);

    // ── D: the name in use finds her, the birth surname does not block it ──
    // HR has her as "de Wittz", the account as "Bakker-de Wittz", and someone
    // else really is a "de Wittz". Reading only the columns leaves this account
    // orphaned; counting the tie across both names sends it to review. Neither
    // is right — exactly one person is called "Bakker-de Wittz".
    await openIdentityFromList(page, `${d.given} ${d.inUse}`);
    const panelD = await linkedAccountsPanel(page);
    await expect(panelD.getByRole('button', { name: `${d.given} ${d.inUse}`, exact: true }))
      .toBeVisible({ timeout: 15000 });
    expect(await linkedAccountNames(IDS.ownerD)).toEqual([`${d.given} ${d.inUse}`]);
    expect(await linkedAccountNames(IDS.namesakeD)).toEqual([]);

    // ── E: a birth surname does not tie up a name that is unique in use ──
    // Two people are indexed under "Jansenz": one is called it, the other only
    // was. A plain "Fleur Jansenz" account therefore matches both and ties —
    // a link the engine used to make and must keep making. Each account goes to
    // the person it is actually named after, through the UI for the owner.
    await openIdentityFromList(page, `${e.given} ${e.name}`);
    const panelE = await linkedAccountsPanel(page);
    await expect(panelE.getByRole('button', { name: `${e.given} ${e.name}`, exact: true }))
      .toBeVisible({ timeout: 15000 });
    expect(await linkedAccountNames(IDS.ownerE)).toEqual([`${e.given} ${e.name}`]);
    // ...and the other person keeps her own, which is the paired positive:
    // preferring the name in use must not cost the one whose name it is not.
    expect(await linkedAccountNames(IDS.otherE)).toEqual([`${e.given} ${e.other}`]);
  });

  test('the accounts it declined to place are still shown as orphans', async () => {
    if (!seeded.ready) { test.skip(true, 'Could not seed through the ingest API (SQL mode required)'); return; }

    // The flip side of B and C. "Not linked to the namesake" would also be true
    // if the account had been swallowed somewhere, so assert the positive: it is
    // on the Orphaned Accounts report, where an analyst picks it up. And A, D
    // and E are NOT, because they found their owners.
    const res = await fetch(`${API}/reports/orphaned-accounts/rows`);
    expect(res.ok).toBe(true);
    const orphanIds = new Set(((await res.json())?.rows || []).map(r => r._entity?.id));

    expect(orphanIds.has(IDS.orphanB)).toBe(true);
    expect(orphanIds.has(IDS.orphanC)).toBe(true);
    expect(orphanIds.has(IDS.orphanA)).toBe(false);
    expect(orphanIds.has(IDS.orphanD)).toBe(false);
    expect(orphanIds.has(IDS.orphanE)).toBe(false);
    expect(orphanIds.has(IDS.orphanEOther)).toBe(false);
  });
});
