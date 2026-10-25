// @ts-check
/**
 * The demo data seeds admin accounts whose only clue to their owner is their
 * login (#1465), under the `adm-<first initial><surname>` convention a real
 * tenant hands out beside `adm-<email local part>`.
 *
 * Why this is an e2e and not only a Pester assertion over the generated JSON:
 * the Pester tests (test/unit/DemoRealism.Tests.ps1) pin the SEED — the counts,
 * the empty columns, the forced ambiguous login. They cannot show that those
 * accounts survive the ingest with their columns still empty, nor what a real
 * linking run decides about them. Both are what makes the seed worth having, and
 * both are read here against the running deployment:
 *
 *   1. the accounts arrived, and arrived EMPTY — no employee id, no name
 *      columns, no department, and a display name that spells the login rather
 *      than the person. An account that kept any of those would link through
 *      another signal and would prove nothing about the login.
 *   2. the older `adm-<email local part>` accounts are still there, still
 *      stamped with an employee id — both conventions are exercised, which is
 *      the half of the issue that is about NOT changing anything.
 *   3. every one of those logins is spelled after somebody really in the
 *      directory, recomputed from the identities' own name columns. A login
 *      nobody answers to is evidence of nothing and would sit orphaned for ever.
 *   4. a real run attaches each unambiguous login to its owner, and holds the
 *      one that fits more than one person for review instead.
 *
 * (4) needs the login-local-part signal of #1454, which is the engine half this
 * issue deliberately does not ship ("No engine or API changes. The signal itself
 * is #1454"). Those two tests therefore skip while the deployment's active rules
 * carry no such signal, and assert for real as soon as they do — see
 * `hasLoginNameSignal` below. (1)-(3) hold either way.
 *
 * Dataset-dependent by design, and the one spec in this suite that is: these
 * accounts ARE the shipped demo data, so there is nothing to seed. It skips when
 * the deployment was not loaded with the realism slice (the **Include the
 * realism slice** tick on the demo crawler, `-IncludeRealism` on the generator)
 * and asserts for real when it was.
 *
 * It deliberately does NOT switch the slice on itself. The slice is additive and
 * cannot be unloaded, and docs/architecture/demo-dataset.md records that the E2E
 * suite pins the standard 26-person counts — a spec that grew the deployment to
 * ~1,200 principals would decide what every spec after it sees. Loading the demo
 * with the tick on is the operator's (or the build pipeline's) step; this spec is
 * what reads the result.
 *
 * It seeds nothing and removes nothing; it does trigger a real linking run,
 * which is the deployment's own idempotent admin action.
 */

import { test, expect } from '@playwright/test';
import {
  BASE, API, linkingRules, runAccountLinkingFromAdmin, latestCompletedRun, linkedPrincipalIds,
} from './accountLinkingSeed';

/** The job title every separate admin account in the demo data carries. */
const ADMIN_JOB_TITLE = 'Administrative account';

/** Login local part of a row from /api/users, which serves the address as `userPrincipalName`. */
const loginOf = (row) => String(row.userPrincipalName || '').split('@')[0].toLowerCase();

/**
 * The `<first initial><surname>` login key of a person, from their clean name
 * columns — the same normalisation the seed and the on-premises samAccountName
 * use (particles stay in, so "van den Berg" becomes "vandenberg").
 *
 * Recomputed here rather than read back off the accounts, so a login that stops
 * being spelled after a real person fails instead of matching itself.
 */
function loginKey(givenName, surname) {
  if (!givenName || !surname) return '';
  return (givenName.slice(0, 1) + String(surname).replace(/[^\p{L}]/gu, '')).toLowerCase();
}

/**
 * Whether the deployment's rules carry the signal #1454 adds: one that reads an
 * account's LOGIN as a name. The two name signals shipped today (`fullName`,
 * `surnameInitial`) read the display name and the structured columns and carry
 * no field of their own, so naming a login source is what tells them apart.
 */
function hasLoginNameSignal(rules) {
  return (rules?.signals || []).some(s => (s.type === 'name' || s.type === 'fuzzy')
    && /login|local[-_ ]?part|email|upn/i.test(`${s.name} ${s.field ?? ''} ${s.source ?? ''}`));
}

/** Every separate admin account in the deployment, both conventions. */
async function adminAccounts() {
  const res = await fetch(`${API}/users?search=${encodeURIComponent('adm-')}&limit=2000`);
  if (!res.ok) return [];
  return ((await res.json())?.data ?? []).filter(r => r.jobTitle === ADMIN_JOB_TITLE);
}

/**
 * Identities indexed under their login key — several people can share one.
 *
 * Paged, because /api/identities caps a page at 500 and the realism slice has
 * more people than that: reading one page would silently lose the rival who
 * makes a login ambiguous, and the ambiguity assertion would pass by omission.
 */
async function identitiesByLoginKey() {
  const index = new Map();
  const pageSize = 500;
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const res = await fetch(`${API}/identities?limit=${pageSize}&offset=${offset}`);
    if (!res.ok) break;
    const rows = (await res.json())?.data ?? [];
    for (const row of rows) {
      const key = loginKey(row.givenName, row.surname);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    if (rows.length < pageSize) break;
  }
  return index;
}

let rules;
/** The `adm-<initial><surname>` accounts: no dot in the login, because there is no address in it. */
let byLogin = [];
/** The `adm-<email local part>` accounts, which carry their owner's dotted address. */
let byAddress = [];
let owners = new Map();

test.beforeAll(async () => {
  rules = await linkingRules();
  const accounts = await adminAccounts();
  byLogin = accounts.filter(r => !loginOf(r).includes('.'));
  byAddress = accounts.filter(r => loginOf(r).includes('.'));
  owners = await identitiesByLoginKey();
});

/**
 * The people one `adm-<initial><surname>` account could belong to. Every seeded
 * login is the plain spelling of somebody's name, so this is only empty when the
 * login names nobody in the directory — which the third test below forbids.
 */
const ownersOf = (account) => owners.get(loginOf(account).replace(/^adm-/, '')) ?? [];

test.describe('Demo admin accounts under the adm-initial-surname convention (#1465)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(byLogin.length === 0,
      'this deployment carries no adm-<initial><surname> admin accounts — load the demo data with the realism slice');
  });

  test('the accounts arrived, and arrived with nothing but their login', async () => {
    expect(byLogin.length,
      'the login signal needs a population to be read on').toBeGreaterThanOrEqual(10);

    for (const account of byLogin) {
      const login = loginOf(account);
      // Plain, never numbered: a trailing digit run is a login shape the engine
      // cannot yet spell back to a name (#1468), so the seed skips the namesake
      // who would have got one rather than adding an account nothing can link.
      expect(login).toMatch(/^adm-[a-z]+$/);
      // Nothing on the account says whose it is...
      for (const column of ['employeeId', 'givenName', 'surname', 'department']) {
        expect(account[column] ?? '', `${login} kept its ${column}, so its login is not the only evidence`).toBe('');
      }
      // ...not even the display name, which spells the login rather than the person.
      expect(account.displayName).toBe(login);
    }
  });

  test('the older adm-<email> admin accounts are still stamped and still there', async () => {
    // The half of this issue that is about changing nothing: the convention that
    // was already in the demo data is what exercises the employee-id and
    // email-prefix routes to the same person.
    expect(byAddress.length).toBeGreaterThanOrEqual(10);
    for (const account of byAddress) {
      expect(account.employeeId, `${loginOf(account)} lost its employee id`).toBeTruthy();
    }
  });

  test('every login is spelled after somebody really in the directory', async () => {
    const unknown = byLogin.filter(a => ownersOf(a).length === 0).map(loginOf);
    expect(unknown, 'a login nobody in the directory answers to can never be attributed').toEqual([]);
    // Both outcomes the demo has to be able to show.
    expect(byLogin.filter(a => ownersOf(a).length === 1).length,
      'no login points at exactly one person, so nothing can auto-link').toBeGreaterThanOrEqual(1);
    expect(byLogin.filter(a => ownersOf(a).length > 1).length,
      'no login fits two people, so nothing can be held for review').toBeGreaterThanOrEqual(1);
  });

  test('a linking run attaches each unambiguous login to its owner', async ({ page }) => {
    test.skip(!hasLoginNameSignal(rules),
      'the active rules carry no login-local-part name signal yet (#1454) — these accounts stay orphaned by design');
    // A deployment that stopped linking Admin accounts, or raised the certainty
    // slider past a name signal's weight, would hold them back for reasons that
    // have nothing to do with this seed.
    const nameWeight = Math.max(0, ...(rules?.signals || [])
      .filter(s => s.type === 'name' || s.type === 'fuzzy').map(s => s.weight || 0));
    test.skip(!(rules?.onlyLinkTypes || []).includes('Admin') || (rules?.linkThreshold ?? 0) > nameWeight,
      'this deployment\'s linking rules would not link an admin account on a name signal');

    await runAccountLinkingFromAdmin(page);

    // Particle surnames are excluded deliberately: whether a concatenated
    // "jvandenberg" matches "van den Berg" is #1454's contract, not this seed's.
    const unambiguous = byLogin
      .filter(a => ownersOf(a).length === 1 && !String(ownersOf(a)[0].surname).includes(' '));
    expect(unambiguous.length, 'no particle-free unambiguous login to check').toBeGreaterThanOrEqual(1);

    const unlinked = [];
    for (const account of unambiguous) {
      const owner = ownersOf(account)[0];
      if (!(await linkedPrincipalIds(owner.id)).includes(account.id)) {
        unlinked.push(`${loginOf(account)} → ${owner.displayName}`);
      }
    }
    expect(unlinked, 'accounts whose login names exactly one person, left unattached').toEqual([]);
  });

  test('the login more than one person answers to is held for review, not linked', async ({ page }) => {
    test.skip(!hasLoginNameSignal(rules),
      'the active rules carry no login-local-part name signal yet (#1454) — nothing is held on a login');

    const ambiguous = byLogin.filter(a => ownersOf(a).length > 1);
    expect(ambiguous.length).toBeGreaterThanOrEqual(1);

    // None of the rival owners may have inherited the account — the run has to
    // decide, and on a name two people answer to the only safe decision is not to.
    const wrongly = [];
    for (const account of ambiguous) {
      for (const owner of ownersOf(account)) {
        if ((await linkedPrincipalIds(owner.id)).includes(account.id)) {
          wrongly.push(`${loginOf(account)} → ${owner.displayName}`);
        }
      }
    }
    expect(wrongly, 'an account whose login fits several people was attached to one of them').toEqual([]);

    const run = await latestCompletedRun();
    expect(run?.nameOnlyMatches ?? 0,
      'a run over this data must report at least the forced ambiguous admin login').toBeGreaterThanOrEqual(1);

    // And it is reviewable: the run names the account, so the Name-only matches
    // card can list it. The stored list is capped, so a deployment that held
    // more than the cap need not contain this particular one.
    const ids = new Set(byLogin.map(a => a.id));
    const held = (run?.nameOnlySuggestions ?? []).filter(s => ids.has(s.principalId));
    test.skip(held.length === 0,
      `no seeded admin login is inside this run's capped suggestion list (held ${run?.nameOnlyMatches})`);
    for (const suggestion of held) {
      expect(suggestion.identityId, 'a suggestion with no candidate identity is not reviewable').toBeTruthy();
      expect(suggestion.signals.length).toBeGreaterThan(0);
    }

    await page.goto(`${BASE}/#admin?sub=account-linking`);
    await page.waitForLoadState('networkidle');
    const table = page.getByRole('table', { name: /Name-only matches held for review/i });
    if (!(await table.isVisible({ timeout: 15000 }).catch(() => false))) {
      test.skip(true, 'Account Linking admin tab not available to this user (needs admin.crawlers)');
    }
    const login = byLogin.find(a => a.id === held[0].principalId);
    await expect(table.locator('tr', { hasText: loginOf(login) }).first()).toBeVisible({ timeout: 15000 });
  });
});
