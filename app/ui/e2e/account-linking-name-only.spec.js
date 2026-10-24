// @ts-check
//
// Account linking must not attach an account to a person on a display name somebody else
// answers to (#1440). Against the live, demo-data-loaded deployment this spec checks, end
// to end:
//
//   1. the shipped policy is readable from the active rules, and a real run honours it,
//   2. the run reports what it held back and what it removed, with the evidence and the
//      reason,
//   3. an account the run held back is NOT linked in the resulting data,
//   4. a second run over the same data detaches nothing — the policy converges instead of
//      churning every name-only link on every run.
//
// (3) and (4) are the assertions a unit test cannot make: they read the stored links back
// through the identities API, and they run the engine twice against one database. A run
// that both reports a match as held and writes it, or a cleanup that keeps detaching links
// it immediately re-creates, fails here while every mocked test stays green.
//
// The run is a real POST, so this spec changes deployment state — it links accounts the
// same way the post-crawl auto-run does. That is deliberate: a dry-run would not prove the
// writes.

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

/** The active rules, with the shipped defaults merged in by the API. */
async function fetchRules() {
  const res = await fetch(`${API}/account-linking/config`);
  if (!res.ok) return null;
  return (await res.json())?.rules ?? null;
}

/** Signal names that are a name match and nothing else — mirrors nameSignalNames(). */
function nameSignalNames(rules) {
  return new Set((rules?.signals || [])
    .filter(s => s.type === 'name' || s.type === 'fuzzy')
    .map(s => s.name));
}

/** Start a run and poll until it is no longer pending/running. */
async function runLinking() {
  const started = await fetch(`${API}/account-linking/runs`, { method: 'POST' });
  if (!started.ok) return null;
  const { id } = await started.json();

  for (let i = 0; i < 90; i++) {
    const res = await fetch(`${API}/account-linking/runs/${id}`);
    if (res.ok) {
      const run = await res.json();
      if (run.status === 'completed' || run.status === 'failed') return run;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

let rules;
let completedRun;

test.beforeAll(async () => {
  rules = await fetchRules();
  test.skip(!rules, 'account-linking config endpoint not available to this user');
  completedRun = await runLinking();
});

test.describe('Account linking — no auto-link on a name somebody else answers to', () => {
  test.describe.configure({ mode: 'serial', timeout: 240000 });

  test('the shipped policy links a name-only match only where the name is unique', async () => {
    // The key may be absent on an install that saved its rules before the feature; the
    // API merges DEFAULT_RULES, so an absent key must read as the shipped policy and not
    // as the stricter opt-out.
    expect(rules.allowNameOnlyLinks === false).toBe(false);
    // The guard, not the threshold, is what holds an ambiguous name-only match back — so
    // the threshold is deliberately still below a single name signal's weight.
    const nameWeights = (rules.signals || [])
      .filter(s => s.type === 'name' || s.type === 'fuzzy')
      .map(s => s.weight || 0);
    expect(Math.max(0, ...nameWeights)).toBeGreaterThanOrEqual(rules.linkThreshold ?? 50);
  });

  test('a run completes and reports its name-only figures', async () => {
    test.skip(!completedRun, 'could not start an account-linking run (needs admin.crawlers)');
    expect(completedRun.status).toBe('completed');

    // All three columns are written by a run under the guard — null would mean the
    // migration or the completion UPDATE never landed.
    expect(typeof completedRun.nameOnlyMatches).toBe('number');
    expect(typeof completedRun.linksRemoved).toBe('number');
    expect(Array.isArray(completedRun.nameOnlySuggestions)).toBe(true);
    // The count is the true number; the stored list is capped, never longer than it.
    expect(completedRun.nameOnlyMatches).toBeGreaterThanOrEqual(completedRun.nameOnlySuggestions.length);
  });

  test('each held-back match names the account, the identity, the evidence and the reason', async () => {
    test.skip(!completedRun, 'no completed run');
    test.skip(!completedRun.nameOnlySuggestions?.length,
      'this dataset produced no name-only matches — nothing to inspect');

    const names = nameSignalNames(rules);
    for (const s of completedRun.nameOnlySuggestions) {
      expect(s.principalId, 'a suggestion without an account is not reviewable').toBeTruthy();
      expect(s.identityId, 'a suggestion without a candidate identity is not reviewable').toBeTruthy();
      expect(typeof s.confidence).toBe('number');
      // The whole point of the record: every signal it rested on is a name signal.
      expect(s.signals.length).toBeGreaterThan(0);
      for (const sig of s.signals) expect(names.has(sig), `${sig} is not a name signal`).toBe(true);
      expect(['ambiguousName', 'uncorroborated']).toContain(s.reason);
      if (s.reason === 'ambiguousName') {
        // Held because somebody else answers to the name — so it has to say who, or an
        // analyst has nothing to act on.
        expect(s.rivalCount, 'an ambiguous match with no rival is a contradiction').toBeGreaterThan(0);
        expect(s.rivals.length).toBeGreaterThan(0);
        for (const rival of s.rivals) expect(rival.identityId).toBeTruthy();
      } else {
        expect(s.rivalCount).toBe(0);
      }
    }
  });

  test('no account the run held back is linked in the data', async () => {
    test.skip(!completedRun, 'no completed run');
    const held = (completedRun.nameOnlySuggestions ?? []).slice(0, 25);
    test.skip(held.length === 0, 'this dataset produced no name-only matches — nothing to check');

    const offenders = [];
    for (const s of held) {
      const res = await fetch(`${API}/identities/${s.identityId}`);
      if (!res.ok) continue;
      const members = (await res.json())?.members ?? [];
      if (members.some(m => m.principalId === s.principalId)) {
        offenders.push(`${s.identityId}/${s.principalId}`);
      }
    }
    expect(offenders, 'accounts reported as held for review but linked anyway').toEqual([]);
  });

  test('a second run detaches nothing and holds back the same matches', async () => {
    // Convergence. The run removes the name-only links the policy would no longer make;
    // a cleanup scoped too widely detaches and re-creates the same links on every run,
    // which looks harmless in the UI and churns an account's history forever.
    test.skip(!completedRun, 'no completed run');
    const second = await runLinking();
    test.skip(!second, 'could not start the second account-linking run');

    expect(second.status).toBe('completed');
    expect(second.linksRemoved, 'the second run re-detached links the first one settled').toBe(0);
    expect(second.nameOnlyMatches).toBe(completedRun.nameOnlyMatches);
  });

  test('Admin → Account Linking exposes the policy control and the held-for-review card', async ({ page }) => {
    await page.goto(`${BASE}/#admin?sub=account-linking`);
    await page.waitForLoadState('networkidle');

    const checkbox = page.getByRole('checkbox', { name: /Link on a name match alone/i });
    if (!(await checkbox.isVisible({ timeout: 15000 }).catch(() => false))) {
      test.skip(true, 'Account Linking admin tab not available to this user (needs admin.crawlers)');
    }
    // Checked is the shipped policy; unchecking it is the documented way to the stricter one.
    await expect(checkbox).toBeChecked();

    await expect(page.getByRole('heading', { name: /Name-only matches \(held for review\)/i })).toBeVisible();
    // Either the list or an explicit empty state — never a silently blank card.
    const table = page.getByRole('table', { name: /Name-only matches held for review/i });
    const empty = page.getByText(/held nothing back|No completed run has reported/i);
    expect(await table.count() + await empty.count()).toBeGreaterThan(0);
  });
});
