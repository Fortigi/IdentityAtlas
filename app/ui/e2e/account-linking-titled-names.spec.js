// @ts-check
/**
 * Account Linking does not attach an account to a namesake because the owner's
 * HR display name carries a title or a particle surname (#1439).
 *
 * Reported symptom, walked here end to end: an orphan account named
 * "Jan de Vries" showed up under the *untitled* namesake's Linked Accounts,
 * while the person it belongs to — "Jan de Vries MSc" in HR — showed none.
 * `parseName` read the first word of the display name as the given name and the
 * LAST as the surname, so a title became the surname ("msc") and a particle
 * surname lost its particles ("van den Berg" → "berg"). The owner was indexed
 * under a name nobody has, stopped being a candidate for her own account, and
 * the account went to whoever still spelled the same.
 *
 * Three families are seeded, each a different face of the same defect, and all
 * three are decided by ONE linking run:
 *
 *   A  titled owner, no namesake   → her account must land on HER
 *                                    (before the fix: linked to nobody)
 *   B  titled owner + untitled     → a genuine tie, so the account must land on
 *      namesake                      NEITHER and go to review
 *                                    (before the fix: confidently the namesake)
 *   C  "Bakker-van der Hoeve"      → two different families; the account must
 *      vs "van der Hoeve"            land on neither
 *                                    (before the fix: the last word matched)
 *
 * A is what makes B and C meaningful: it proves the run actually linked
 * something, so "no link" in B and C is a decision and not a run that did
 * nothing.
 *
 * Dataset-independent. Everything it asserts over, it seeds itself through the
 * ingest API under a system of its own and a per-run name token, so it runs
 * against the demo dataset and a real tenant alike, and removes its own rows
 * afterwards. It does trigger a real linking run, which is the reporter's path
 * and the deployment's own idempotent admin action.
 */

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

// A token that makes every seeded surname unique to this run, so the spec can
// never match a real person and two concurrent runs can't see each other.
// Lower-case alphanumerics only: the name parser folds everything else away.
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);

/** The three families, as the HR source and the accounts spell them. */
const FAMILIES = {
  // Particle surname + a post-nominal title, exactly as reported.
  a: { given: 'Jan', surname: `de Vriesz${TOKEN}`, title: 'MSc' },
  // Same shape, plus a real namesake who has no title.
  b: { given: 'Lotte', surname: `van der Steenz${TOKEN}`, title: 'MSc' },
  // A hyphenated compound whose tail is another family's whole surname.
  c: { compound: `Bakker-van der Hoevez${TOKEN}`, plain: `van der Hoevez${TOKEN}`, given: 'Mark' },
};

const plain = (f) => `${f.given} ${f.surname}`;
const titled = (f) => `${f.given} ${f.surname} ${f.title}`;

/** Ids are minted up front so the seed, the assertions and the cleanup agree. */
const IDS = {
  ownerA: randomUUID(), ownerB: randomUUID(), namesakeB: randomUUID(), ownerC: randomUUID(),
  orphanA: randomUUID(), orphanB: randomUUID(), orphanC: randomUUID(),
};

/** State the seed creates and the teardown has to give back. */
const seeded = { crawlerId: null, apiKey: null, systemId: null, ready: false };

async function postJson(url, body, apiKey) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** One ingest batch under the seeded crawler key + system. Throws on refusal. */
async function ingest(entity, body) {
  const res = await postJson(`${API}/ingest/${entity}`, { systemId: seeded.systemId, syncMode: 'delta', records: [], ...body }, seeded.apiKey);
  if (!res.ok) throw new Error(`ingest ${entity} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** An identity as an HR source writes it: free-text display name, clean columns. */
const identity = (id, displayName, given, surname) => ({
  id, displayName, givenName: given, surname,
  email: `${given}.${surname.replace(/[^A-Za-z0-9]/g, '')}.${id.slice(0, 4)}@e2e-1439.example`.toLowerCase(),
  employeeId: `E2E1439-${id.slice(0, 8)}`,
  companyName: 'E2E #1439',
});

/**
 * An account with no address and no employee id, so the name signals are the
 * only evidence there is — which is the condition the defect needed.
 */
const orphanAccount = (id, displayName) => ({
  id, displayName, principalType: 'User', accountEnabled: true,
});

/**
 * Seed a system, three HR identities and three orphan accounts. Returns false
 * when the deployment won't allow it (mock mode, or an API key that may not
 * ingest), which is the only reason this spec skips.
 */
async function seed() {
  const created = await postJson(`${API}/admin/crawlers`, {
    displayName: `e2e-1439-${TOKEN}`,
    description: 'Throwaway key for the #1439 account-linking E2E. Removed by the spec.',
    permissions: ['ingest'],
  });
  if (!created.ok) return false;
  const crawler = await created.json();
  seeded.crawlerId = crawler.id;
  seeded.apiKey = crawler.apiKey;

  const sys = await postJson(`${API}/ingest/systems`, {
    syncMode: 'delta',
    records: [{ systemType: 'HR', tenantId: `e2e-1439-${TOKEN}`, displayName: `E2E #1439 HR (${TOKEN})` }],
  }, seeded.apiKey);
  if (!sys.ok) return false;
  seeded.systemId = (await sys.json()).systemIds?.[0];
  if (!seeded.systemId) return false;

  const { a, b, c } = FAMILIES;
  await ingest('identities', {
    records: [
      // A: the only person of her name, and HR spells her with a title.
      identity(IDS.ownerA, titled(a), a.given, a.surname),
      // B: two real people called the same thing, one of them titled.
      identity(IDS.ownerB, titled(b), b.given, b.surname),
      identity(IDS.namesakeB, plain(b), b.given, b.surname),
      // C: a hyphenated compound surname, no title involved.
      identity(IDS.ownerC, `${c.given} ${c.compound}`, c.given, c.compound),
    ],
  });

  await ingest('principals', {
    records: [
      orphanAccount(IDS.orphanA, plain(a)),
      orphanAccount(IDS.orphanB, plain(b)),
      // C's account spells the OTHER family — it must not be absorbed.
      orphanAccount(IDS.orphanC, `${c.given} ${c.plain}`),
    ],
  });
  return true;
}

/**
 * Give the deployment its rows back: the identities (which cascades the links
 * this run wrote), then the accounts, then the system and the key.
 *
 * Principals are a soft-delete table, so the three throwaway accounts are
 * tombstoned rather than removed and the tombstone purge finalises them after
 * the history-retention window — that is the ingest contract, not something to
 * work around here. A tombstoned account is still counted as an orphan today
 * (#1442), so they are reclassified as non-human first: that is the one class
 * no human-facing surface reports on, and it keeps three ex-fixtures off a real
 * deployment's Orphaned Accounts report while they age out.
 *
 * The system row itself can only be disabled — the API has no delete for
 * Systems — so one disabled "E2E #1439 HR" connector per replay is residue the
 * spec cannot clear.
 */
async function unseed() {
  if (seeded.apiKey && seeded.systemId) {
    await ingest('identities', { deletedIds: [IDS.ownerA, IDS.ownerB, IDS.namesakeB, IDS.ownerC] }).catch(() => {});
    await ingest('principals', {
      records: [IDS.orphanA, IDS.orphanB, IDS.orphanC].map(id => ({ id, principalType: 'ServicePrincipal' })),
    }).catch(() => {});
    // An empty FULL batch is how a source says "this scope is empty now".
    await ingest('principals', { syncMode: 'full' }).catch(() => {});
    await fetch(`${API}/systems/${seeded.systemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, description: 'Disabled leftover of the #1439 account-linking E2E.' }),
    }).catch(() => {});
  }
  if (seeded.crawlerId != null) {
    await fetch(`${API}/admin/crawlers/${seeded.crawlerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permanent: true }),
    }).catch(() => {});
  }
}

/** The display names under an identity's Linked Accounts, read from the API. */
async function linkedAccountNames(identityId) {
  const res = await fetch(`${API}/identities/${identityId}`);
  if (!res.ok) return [];
  return ((await res.json())?.members || []).map(m => m.displayName);
}

/** Admin → Account Linking → Run now, waited out to completion. */
async function runAccountLinking(page) {
  await page.goto('/#admin?sub=account-linking');
  const runNow = page.getByRole('button', { name: /Run now/i });
  await expect(runNow).toBeVisible({ timeout: 15000 });
  await runNow.click();
  // The panel polls the run row and reports the counts when it finishes. A run
  // scans every orphan in the deployment, so allow for a populated tenant.
  await expect(page.getByText(/Linking complete/i)).toBeVisible({ timeout: 180000 });
}

/** Identities → search → open one, the way the reporter got there. */
async function openIdentityFromList(page, displayName) {
  await page.goto('/#identities');
  const search = page.getByPlaceholder(/Search by name, email/i);
  await expect(search).toBeVisible({ timeout: 15000 });
  await search.fill(displayName);
  await page.getByText(displayName, { exact: true }).first().click();
}

/** The Linked Accounts panel on an identity's Relationships tab. */
async function linkedAccountsPanel(page) {
  await page.getByRole('tab', { name: /Relationships/i }).click();
  const panel = page.locator('div:has(> h3:text-is("Linked Accounts"))');
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
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

  test('one run decides all three families correctly', async ({ page }) => {
    if (!seeded.ready) { test.skip(true, 'Could not seed through the ingest API (SQL mode required)'); return; }
    test.setTimeout(240000);

    const { a, b, c } = FAMILIES;

    // ── The reporter's path: Admin → Account Linking → Run ──────────────
    await runAccountLinking(page);

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
  });

  test('the accounts it declined to place are still shown as orphans', async () => {
    if (!seeded.ready) { test.skip(true, 'Could not seed through the ingest API (SQL mode required)'); return; }

    // The flip side of B and C. "Not linked to the namesake" would also be true
    // if the account had been swallowed somewhere, so assert the positive: it is
    // on the Orphaned Accounts report, where an analyst picks it up. And A is
    // NOT, because it found its owner.
    const res = await fetch(`${API}/reports/orphaned-accounts/rows`);
    expect(res.ok).toBe(true);
    const orphanIds = new Set(((await res.json())?.rows || []).map(r => r._entity?.id));

    expect(orphanIds.has(IDS.orphanB)).toBe(true);
    expect(orphanIds.has(IDS.orphanC)).toBe(true);
    expect(orphanIds.has(IDS.orphanA)).toBe(false);
  });
});
