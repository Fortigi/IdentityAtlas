// @ts-check
//
// Account linking must not attach an account to a person on a display name somebody else
// answers to — at the level the match rests on (#1440, scoped by #1460). Against the live
// deployment this spec checks, end to end:
//
//   1. the shipped policy is readable from the active rules, and a real run honours it,
//   2. the run reports what it held back and what it removed, with the evidence and the
//      reason,
//   3. an account the run held back is NOT linked in the resulting data,
//   4. a second run over the same data detaches nothing — the policy converges instead of
//      churning every name-only link on every run,
//   5. the reporter's path for #1460: an account whose full name exactly one person is
//      spelled LINKS although others share its surname and first initial, while a real
//      namesake stays held — and the held-for-review card says which name the rivals
//      actually share.
//
// (3), (4) and (5) are the assertions a unit test cannot make: they read the stored links
// back through the identities API, and they run the engine twice against one database. A
// run that both reports a match as held and writes it, or a cleanup that keeps detaching
// links it immediately re-creates, fails here while every mocked test stays green. (4) is
// also the retroactive half of #1460: a link made on a name shared only at the weaker
// level must survive the next run's stale-link scan.
//
// The #1460 fixture is seeded through the ingest API under a system of its own and a
// per-run name token — the demo dataset's realism slice has surname+initial collisions by
// construction, but pre-links its cross-system accounts on employeeId, so the symptom is
// not guaranteed out of the box.
//
// The run is a real POST, so this spec changes deployment state — it links accounts the
// same way the post-crawl auto-run does. That is deliberate: a dry-run would not prove the
// writes.

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  BASE, API, openIngestSession, closeIngestSession, linkingRules,
  runAccountLinkingFromAdmin, linkedAccountNames, latestCompletedRun,
} from './accountLinkingSeed';

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

// ── The #1460 fixture ────────────────────────────────────────────────────────
//
// Two families, both seeded with single-token surnames so the name parser cannot read a
// particle as the surname and confuse the question being asked here.
//
//   SHARED  three unrelated people whose given names all start with Y. An account spelled
//           exactly one of their names must land on HER — that is the regression.
//   TWIN    two people really called the same thing, plus a third one initial away. The
//           account must stay held, and the rival named must be the real namesake only.
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const SHARED = `Elmahdiz${TOKEN}`;
const TWIN = `Benaliz${TOKEN}`;

const IDS = {
  youssef: randomUUID(), yasmina: randomUUID(), yassin: randomUUID(),
  karim: randomUUID(), karimTwin: randomUUID(), khalid: randomUUID(),
  orphanYoussef: randomUUID(), orphanKarim: randomUUID(),
};

const NAMES = {
  youssef: `Youssef ${SHARED}`,
  yasmina: `Yasmina ${SHARED}`,
  yassin: `Yassin ${SHARED}`,
  karim: `Karim ${TWIN}`,
  khalid: `Khalid ${TWIN}`,
};

/** An HR person: a display name, clean columns and an address of her own. */
const person = (id, displayName) => {
  const [given, surname] = displayName.split(' ');
  return {
    id, displayName, givenName: given, surname,
    email: `${given}.${surname}.${id.slice(0, 4)}@e2e-1460.example`.toLowerCase(),
    employeeId: `E2E1460-${id.slice(0, 8)}`,
    companyName: 'E2E #1460',
  };
};

/**
 * A directory account with no address and no employee id, so the name signals are the
 * only evidence there is — the condition the regression needs.
 */
const orphanAccount = (id, displayName) => ({
  id, displayName, principalType: 'User', accountEnabled: true,
});

let rules;
let completedRun;
let seeded = null;

test.beforeAll(async () => {
  rules = await linkingRules();
  test.skip(!rules, 'account-linking config endpoint not available to this user');

  seeded = await openIngestSession({
    displayName: `e2e-1460-${TOKEN}`,
    description: 'Throwaway key for the #1460 account-linking E2E. Removed by the spec.',
    system: { systemType: 'HR', tenantId: `e2e-1460-${TOKEN}`, displayName: `E2E #1460 HR (${TOKEN})` },
  });
  if (seeded.ok) {
    await seeded.mustIngest('identities', {
      records: [
        person(IDS.youssef, NAMES.youssef),
        person(IDS.yasmina, NAMES.yasmina),
        person(IDS.yassin, NAMES.yassin),
        person(IDS.karim, NAMES.karim),
        person(IDS.karimTwin, NAMES.karim),
        person(IDS.khalid, NAMES.khalid),
      ],
    });
    await seeded.mustIngest('principals', {
      records: [
        orphanAccount(IDS.orphanYoussef, NAMES.youssef),
        orphanAccount(IDS.orphanKarim, NAMES.karim),
      ],
    });
  }

  completedRun = await runLinking();
});

test.afterAll(async () => {
  if (seeded?.systemId) {
    // Off every human-facing surface on the way out: a tombstoned account is no longer an
    // orphan, but the rows outlive the retention window.
    await seeded.ingest('principals', {
      records: [IDS.orphanYoussef, IDS.orphanKarim].map(id => ({ id, principalType: 'ServicePrincipal' })),
    }).catch(() => {});
    await seeded.ingest('principals', { deletedIds: [IDS.orphanYoussef, IDS.orphanKarim] }).catch(() => {});
  }
  await closeIngestSession(seeded, {
    identityIds: [IDS.youssef, IDS.yasmina, IDS.yassin, IDS.karim, IDS.karimTwin, IDS.khalid],
    systemNote: 'Disabled leftover of the #1460 account-linking E2E.',
  });
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

// ── The reporter's path for #1460 ────────────────────────────────────────────
//
// Admin → Account Linking → Run now, then read the result the reporter read: the account
// spelled exactly one person's name was held with rivals who are not called that, and
// ~1,700 correct links per run were lost to it. Both halves are walked here — the
// release, and the hold that must survive it — because releasing everything would also
// make the first assertion pass.

test.describe('Account linking — a rival counts at the level the match rests on (#1460)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeEach(() => {
    test.skip(!seeded?.ok, 'could not seed through the ingest API (SQL mode required)');
    // The fixture matches on the name alone, at full-name strength. A deployment that
    // raised the certainty slider past that weight, or stopped linking plain secondary
    // accounts, would hold both accounts for reasons that have nothing to do with #1460.
    const nameWeight = (rules?.signals || []).find(s => s.name === 'fullName')?.weight ?? 0;
    test.skip(
      !(rules?.onlyLinkTypes || []).includes('Secondary') || (rules?.linkThreshold ?? 0) > nameWeight,
      'the deployment\'s linking rules would not link a name-only match',
    );
  });

  test('the account only one person is spelled lands on her, through the UI', async ({ page }) => {
    await runAccountLinkingFromAdmin(page);

    // The regression: "Youssef" is nobody else's name here, so this account is his — even
    // though Yasmina and Yassin stand one initial away.
    expect(await linkedAccountNames(IDS.youssef)).toEqual([NAMES.youssef]);
    // ...and the two who merely share the surname and initial did not inherit it.
    expect(await linkedAccountNames(IDS.yasmina)).toEqual([]);
    expect(await linkedAccountNames(IDS.yassin)).toEqual([]);

    // Through the identity page, which is where the reporter looked.
    await page.goto(`/#identity:${IDS.youssef}`);
    await page.getByRole('tab', { name: /Relationships/i }).click();
    const panel = page.locator('div:has(> h3:text-is("Linked Accounts"))');
    await expect(panel.getByRole('button', { name: NAMES.youssef, exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('a real namesake still holds the match, and only the namesake is named', async () => {
    // The paired case, and what stops the fix reducing to "whoever matches best wins":
    // two people really are called "Karim", so nothing in the name says which.
    expect(await linkedAccountNames(IDS.karim)).toEqual([]);
    expect(await linkedAccountNames(IDS.karimTwin)).toEqual([]);

    const run = await latestCompletedRun();
    const held = (run?.nameOnlySuggestions ?? []).find(s => s.principalId === IDS.orphanKarim);
    expect(held, `the run did not report the held match for ${NAMES.karim} `
      + `(stored list is capped at 500; this run held ${run?.nameOnlyMatches})`).toBeTruthy();

    expect(held.reason).toBe('ambiguousName');
    expect(held.matchLevel).toBe('full');
    // Khalid shares the surname and the initial and is NOT a rival: he does not answer to
    // the name this match rests on. Naming him is what used to hold Youssef's account.
    expect(held.rivals.map(r => r.identityName)).toEqual([NAMES.karim]);
    expect(held.rivalCount).toBe(1);
  });

  test('the held-for-review card says which name the rivals share', async ({ page }) => {
    await page.goto(`${BASE}/#admin?sub=account-linking`);
    await page.waitForLoadState('networkidle');

    const table = page.getByRole('table', { name: /Name-only matches held for review/i });
    if (!(await table.isVisible({ timeout: 15000 }).catch(() => false))) {
      test.skip(true, 'Account Linking admin tab not available to this user (needs admin.crawlers)');
    }

    const row = table.locator('tr', { hasText: NAMES.karim }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.getByText(/full name also answered to by/i)).toBeVisible();
    // The account that linked is not on the card at all — it is not held, it is placed.
    await expect(table.locator('tr', { hasText: NAMES.youssef })).toHaveCount(0);
  });
});
