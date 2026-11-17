// @ts-check
//
// Shared seeding + driving apparatus for the account-linking e2e specs.
//
// Every account-linking spec that cannot rely on the demo dataset does the same four
// things: register a throwaway ingest connector, register a system of its own, push
// identities and orphan accounts into it, and then drive Admin → Account Linking → Run
// now and read the result back. Three specs carried their own copy of that apparatus;
// this is the one copy they share.
//
// The first two of those four — the connector and the system — are not an
// account-linking concern and now live in `ingestSeed.js`, which every seeding
// spec shares. They are re-exported here so the account-linking specs keep
// importing their whole apparatus from one module.
//
// Not a `*.spec.js`, so Playwright's testMatch never collects it as a suite.

import { expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { BASE, API, openIngestSession, closeIngestSession } from './ingestSeed.js';

export { BASE, API, openIngestSession, closeIngestSession };

/**
 * A per-run name token made of LETTERS only, which every spec that seeds surname
 * stems needs.
 *
 * The token keeps one run's people out of the next one's assertions, and a hex
 * one would be wrong here *silently*: half of them end in a digit, so a surname
 * built on one turns every login spelled after it into a **numbered** login
 * (#1468) — a different shape with different rules. The digit cases would then
 * pass on a surname rather than on the number they are about, and the unnumbered
 * ones would be reading a spelling nobody provisioned.
 */
export const letterToken = () =>
  randomUUID().replace(/-/g, '').slice(0, 8).replace(/[0-9]/g, d => 'ghijklmnop'[Number(d)]);

/**
 * Open a session and push one spec's whole fixture through it: the people first,
 * then the orphan accounts a linking run has to place on them.
 *
 * Every login-convention spec seeds those same two batches into an HR system
 * named after its issue and its run, so this is the one copy of that. Returns
 * the `openIngestSession` handle unchanged — including `{ ok: false, reason }`
 * when the deployment will not allow it, in which case nothing is seeded, so a
 * caller still checks `ok` exactly once.
 *
 * @param {{ issue: string, token: string, identities: object[], accounts: object[] }} fixture
 *   `issue` is the issue number the spec is named after and `token` the per-run
 *   name token, which together keep one run's rows out of the next one's.
 */
export async function seedLinkingFixture({ issue, token, identities, accounts }) {
  const session = await openIngestSession({
    displayName: `e2e-${issue}-${token}`,
    description: `Throwaway key for the #${issue} account-linking E2E. Removed by the spec.`,
    system: { systemType: 'HR', tenantId: `e2e-${issue}-${token}`, displayName: `E2E #${issue} HR (${token})` },
  });
  if (session.ok) {
    await session.mustIngest('identities', { records: identities });
    await session.mustIngest('principals', { records: accounts });
  }
  return session;
}

/**
 * Give a `seedLinkingFixture` fixture back, in the order the human-facing
 * surfaces need it: the accounts are tombstoned first, so none of them is an
 * orphan any more, and `closeIngestSession` then removes the identities,
 * disables the system and deletes the key.
 *
 * Safe on a session that never opened, so a spec can call it unconditionally.
 *
 * @param {object} session the handle from `seedLinkingFixture`
 * @param {{ issue: string, identities: object[], accounts: object[] }} fixture
 */
export async function clearLinkingFixture(session, { issue, identities, accounts }) {
  if (session?.systemId) {
    await session.ingest('principals', { deletedIds: accounts.map(a => a.id) }).catch(() => {});
  }
  await closeIngestSession(session, {
    identityIds: identities.map(i => i.id),
    systemNote: `Disabled leftover of the #${issue} account-linking E2E.`,
  });
}

/**
 * Why this deployment cannot be asked whether a login alone places an account,
 * or `''` when it can.
 *
 * A fixture that carries nothing but its login rests on two things being true of
 * the tenant's active rules: that admin accounts are linked at all, and that the
 * certainty slider sits at or below the login signal's weight. Neither has
 * anything to do with the bug a login-convention spec is about, so a spec skips
 * on this rather than failing — and reports which of the two it was.
 *
 * @param {object|null} rules the effective dictionary from `linkingRules`
 * @returns {string} the skip reason, empty when the deployment can answer
 */
export function loginOnlyLinkingBlocker(rules) {
  const loginWeight = (rules?.signals || []).find(s => s.type === 'loginName')?.weight ?? 0;
  if (!loginWeight) return 'the active dictionary carries no login-reading signal';
  if (!(rules?.onlyLinkTypes || []).includes('Admin')) return 'this deployment does not link Admin accounts';
  if ((rules?.linkThreshold ?? 0) > loginWeight) {
    return `the certainty slider (${rules.linkThreshold}) sits above the login signal's weight (${loginWeight})`;
  }
  return '';
}

/**
 * The deployment's account-linking config as the settings page reads it — the
 * stored row plus `rules`, which the endpoint serves as the *effective*
 * dictionary (the saved rules with the shipped signals merged in by name, #1469).
 *
 * @returns {Promise<object|null>} null when the endpoint is not available to us
 */
export async function linkingConfig() {
  const res = await fetch(`${API}/account-linking/config`);
  if (!res.ok) return null;
  return await res.json();
}

/** The deployment's active linking rules, with the shipped defaults merged in. */
export async function linkingRules() {
  return (await linkingConfig())?.rules ?? null;
}

/**
 * The active weight of one signal, 0 for a signal this dictionary has not got.
 *
 * Which is how a spec states what the deployment has to have switched on, and
 * how it asserts a link's confidence against the tenant's own numbers rather
 * than against the shipped ones — a retuned dictionary must not read as a
 * regression.
 */
export const signalWeight = (rules, name) =>
  (rules?.signals || []).find(s => s.name === name)?.weight ?? 0;

/**
 * Save a dictionary as the deployment's active rules — the same PUT the Save
 * button makes, which is how a tenant's stored rules come to exist at all.
 *
 * There is one config row per deployment, so a spec that calls this changes
 * state every other account-linking surface reads: save the config you found
 * first and put it back on the way out.
 *
 * @param {object} rules the dictionary to store
 * @param {{ schedules?: any[], isActive?: boolean }} [opts]
 * @returns {Promise<boolean>} false when the deployment refused it (mock mode,
 *   or a user without `admin.crawlers`) — the condition a spec skips on
 */
export async function saveLinkingRules(rules, { schedules = [], isActive = true } = {}) {
  const res = await fetch(`${API}/account-linking/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules, schedules, isActive }),
  });
  return res.ok;
}

/**
 * Admin → Account Linking → Run now, waited out to completion — the reporter's own path
 * and the deployment's idempotent admin action.
 *
 * Reloads first: a second run in the same test would otherwise find the previous run's
 * "Linking complete" still on screen and pass instantly. A run scans every orphan in the
 * deployment, so the wait allows for a populated tenant.
 */
export async function runAccountLinkingFromAdmin(page) {
  await page.goto(`${BASE}/#admin?sub=account-linking`);
  await page.reload();
  const runNow = page.getByRole('button', { name: /Run now/i });
  await expect(runNow).toBeVisible({ timeout: 30000 });
  await runNow.click();
  await expect(page.getByText(/Linking complete/i)).toBeVisible({ timeout: 180000 });
}

/**
 * The newest completed run — the one Admin → Account Linking shows, and the one whose
 * `linksRemoved` / `nameOnlySuggestions` a spec reads after driving a run.
 */
export async function latestCompletedRun() {
  const res = await fetch(`${API}/account-linking/runs`);
  if (!res.ok) return null;
  return ((await res.json())?.data ?? []).find(r => r.status === 'completed') ?? null;
}

/** The IdentityMembers rows currently attached to a person, as the API serves them. */
export async function identityMembers(identityId) {
  const res = await fetch(`${API}/identities/${identityId}`);
  if (!res.ok) return [];
  return (await res.json())?.members ?? [];
}

/** The display names under an identity's Linked Accounts. */
export const linkedAccountNames = async (identityId) =>
  (await identityMembers(identityId)).map(m => m.displayName);

/** The principal ids under an identity's Linked Accounts. */
export const linkedPrincipalIds = async (identityId) =>
  (await identityMembers(identityId)).map(m => m.principalId);

/**
 * One identity's member row for an account — the link itself, which is where its
 * `linkSignals` and `linkConfidence` are read from.
 */
export const memberFor = async (identityId, principalId) =>
  (await identityMembers(identityId)).find(m => m.principalId === principalId);

/** The newest completed run's held-for-review record for an account, if any. */
export const heldMatchFor = async (principalId) =>
  ((await latestCompletedRun())?.nameOnlySuggestions ?? []).find(s => s.principalId === principalId);

/** Everything the newest completed run held back, by account id. */
export const heldPrincipalIds = async () =>
  ((await latestCompletedRun())?.nameOnlySuggestions ?? []).map(s => s.principalId);

/** The Orphaned Accounts report as the API serves it — every row, not just a page. */
export async function orphanReport() {
  const res = await fetch(`${API}/reports/orphaned-accounts/rows`);
  expect(res.ok, 'GET /api/reports/orphaned-accounts/rows should succeed').toBe(true);
  return res.json();
}

/** The Linked Accounts panel on an identity's Relationships tab. */
export async function linkedAccountsPanel(page) {
  await page.getByRole('tab', { name: /Relationships/i }).click();
  const panel = page.locator('div:has(> h3:text-is("Linked Accounts"))');
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
}

/**
 * Seed a spec file's fixture once and clear it after, the way every account-linking spec does.
 * Returns the state its tests read: `rules` (the active dictionary; the file is skipped when this
 * user cannot read it) and `seeded` (`seedLinkingFixture`'s answer).
 */
export function withLinkingFixture(test, fixture) {
  const state = { rules: undefined, seeded: null };
  test.beforeAll(async () => {
    state.rules = await linkingRules();
    test.skip(!state.rules, 'account-linking config endpoint not available to this user');
    state.seeded = await seedLinkingFixture(fixture);
  });
  test.afterAll(() => clearLinkingFixture(state.seeded, fixture));
  return state;
}
