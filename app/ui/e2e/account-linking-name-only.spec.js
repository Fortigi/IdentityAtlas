// @ts-check
//
// Account linking must not attach an account to a person on a display-name match alone
// (#1440). Against the live, demo-data-loaded deployment this spec checks the three things
// the acceptance criteria ask for, end to end:
//
//   1. the shipped policy is "a name needs a second signal" — and a real run honours it,
//   2. the run reports what it held back and what it removed, with the signals,
//   3. nothing in the resulting data is linked on name signals alone.
//
// (3) is the assertion that actually matters and the one a unit test cannot make: it reads
// the stored links back through the identities API and checks every engine-scored one
// carries a signal that is not a name. A run that silently kept creating name-only links,
// or a retroactive cleanup that never fired, both fail here while every mocked test stays
// green.
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

test.describe('Account linking — no auto-link on a single name signal', () => {
  test.describe.configure({ mode: 'serial', timeout: 240000 });

  test('the shipped policy requires a second signal beside the name', async () => {
    // The key may be absent on an install that saved its rules before the feature; the
    // API merges DEFAULT_RULES, so an absent key must still read as "not allowed".
    expect(rules.allowNameOnlyLinks === true).toBe(false);
    // The guard, not the threshold, is what holds a name-only match back — so the
    // threshold is deliberately still below a single name signal's weight.
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

  test('each held-back match names the account, the identity and the evidence', async () => {
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
      expect(s.ties).toBeGreaterThanOrEqual(1);
    }
  });

  test('no engine-scored link in the data rests on name signals alone', async () => {
    test.skip(!completedRun, 'no completed run');
    const names = nameSignalNames(rules);

    const listRes = await fetch(`${API}/identities?minAccounts=2&limit=200`);
    expect(listRes.ok).toBe(true);
    const identities = (await listRes.json())?.data ?? [];
    test.skip(identities.length === 0, 'no multi-account identities in this dataset');

    const offenders = [];
    for (const identity of identities) {
      const res = await fetch(`${API}/identities/${identity.id}`);
      if (!res.ok) continue;
      for (const m of (await res.json())?.members ?? []) {
        // Only the engine's own guesses are in scope: a crawler-sourced link carries no
        // confidence, and an analyst decision outranks the rule.
        if (m.linkConfidence == null || m.analystOverride) continue;
        const signals = String(m.linkSignals ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (signals.length > 0 && signals.every(s => names.has(s))) {
          offenders.push(`${identity.id}/${m.principalId} (${signals.join(',')})`);
        }
      }
    }
    expect(offenders, 'accounts linked on name signals alone').toEqual([]);
  });

  test('Admin → Account Linking exposes the opt-out and the held-for-review card', async ({ page }) => {
    await page.goto(`${BASE}/#admin?sub=account-linking`);
    await page.waitForLoadState('networkidle');

    const checkbox = page.getByRole('checkbox', { name: /Link on a name match alone/i });
    if (!(await checkbox.isVisible({ timeout: 15000 }).catch(() => false))) {
      test.skip(true, 'Account Linking admin tab not available to this user (needs admin.crawlers)');
    }
    // Unchecked is the policy; it is the documented way back to the old behaviour.
    await expect(checkbox).not.toBeChecked();

    await expect(page.getByRole('heading', { name: /Name-only matches \(held for review\)/i })).toBeVisible();
    // Either the list or an explicit empty state — never a silently blank card.
    const table = page.getByRole('table', { name: /Name-only matches held for review/i });
    const empty = page.getByText(/held nothing back|No completed run has reported/i);
    expect(await table.count() + await empty.count()).toBeGreaterThan(0);
  });
});
