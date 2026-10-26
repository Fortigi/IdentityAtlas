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
// Not a `*.spec.js`, so Playwright's testMatch never collects it as a suite.

import { expect } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
export const API = `${BASE}/api`;

const jsonBody = (res) => res.json().catch(() => ({}));

/**
 * Register a throwaway ingest connector and a system of its own, and return the handle
 * the spec seeds through.
 *
 * Returns `{ ok: false, reason }` rather than throwing when the deployment will not allow
 * it — mock mode (`USE_SQL=false`) has no Crawlers table and no ingest to drive — which is
 * the one condition the specs skip on.
 *
 * @param {{ displayName: string, description: string, system: object }} opts
 *   `system` is an ingest Systems record: `{ systemType, tenantId, displayName }`.
 * @returns {Promise<{
 *   ok: boolean, reason?: string, crawlerId?: number|string, systemId?: number,
 *   ingest?: Function, mustIngest?: Function,
 * }>}
 */
export async function openIngestSession({ displayName, description, system }) {
  const created = await fetch(`${API}/admin/crawlers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, description, permissions: ['ingest'] }),
  });
  if (created.status !== 201) {
    return { ok: false, reason: `could not register an ingest connector (HTTP ${created.status})` };
  }
  const crawler = await created.json();
  const session = { ok: true, crawlerId: crawler.id, systemId: undefined };

  /**
   * One ingest batch as this connector, scoped to this system. Defaults mirror what every
   * caller wants: a delta batch of no records, so a call only states what it changes.
   * @returns {Promise<{ ok: boolean, status: number, body: any }>}
   */
  session.ingest = async (entity, body = {}) => {
    const res = await fetch(`${API}/ingest/${entity}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${crawler.apiKey}` },
      body: JSON.stringify({ systemId: session.systemId, syncMode: 'delta', records: [], ...body }),
    });
    return { ok: res.ok, status: res.status, body: await jsonBody(res) };
  };

  /** The same, for a batch whose refusal means the fixture is not set up. */
  session.mustIngest = async (entity, body) => {
    const res = await session.ingest(entity, body);
    if (!res.ok) throw new Error(`ingest ${entity} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };

  const registered = await session.ingest('systems', { records: [system] });
  session.systemId = registered.body?.systemIds?.[0];
  if (!session.systemId) {
    return { ...session, ok: false, reason: `could not register the fixture system (HTTP ${registered.status})` };
  }
  return session;
}

/**
 * Give the deployment its rows back.
 *
 * `Principals` is a soft-delete table, so seeded accounts are tombstoned rather than
 * removed and the purge finalises them after the history-retention window — that is the
 * ingest contract, not something to work around here. The system row can only be
 * disabled (the API has no delete for Systems), so one disabled connector per replay is
 * residue no spec can clear.
 *
 * @param {object} session the handle from `openIngestSession`
 * @param {{ identityIds?: string[], principalIds?: string[], systemNote?: string }} what
 */
export async function closeIngestSession(session, { identityIds = [], principalIds = [], systemNote } = {}) {
  if (session?.systemId) {
    // Identities first: a hard delete cascades the IdentityMembers rows this run wrote,
    // so a replay starts with every seeded account orphaned again.
    if (identityIds.length) await session.ingest('identities', { deletedIds: identityIds }).catch(() => {});
    if (principalIds.length) await session.ingest('principals', { deletedIds: principalIds }).catch(() => {});
    if (systemNote) {
      await fetch(`${API}/systems/${session.systemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, description: systemNote }),
      }).catch(() => {});
    }
  }
  if (session?.crawlerId != null) {
    await fetch(`${API}/admin/crawlers/${session.crawlerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permanent: true }),
    }).catch(() => {});
  }
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
