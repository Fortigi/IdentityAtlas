// @ts-check
/**
 * Issue #1204 — filter Principals and Resources by the system they came from,
 * and get one auto-generated context per system for matrix scoping.
 *
 * Runs against the live, demo-data-loaded deployment (five systems), so the
 * assertions are anchored to what `/api/systems` actually reports rather than
 * to hardcoded names.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

/** Every system the deployment knows about, with its row counts. */
async function fetchSystems(request) {
  const res = await request.get(`${API}/systems`);
  if (!res.ok()) return [];
  const body = await res.json();
  return Array.isArray(body) ? body : (body.data ?? []);
}

/** `total` the list endpoint reports for a System filter (or unfiltered). */
async function apiTotal(request, path, systemName) {
  const qs = new URLSearchParams({ limit: '1' });
  if (systemName) qs.set('filters', JSON.stringify({ __system: systemName }));
  const res = await request.get(`${API}/${path}?${qs}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).total;
}

/** Drive the filter bar: "+ Add filter" → field → value. Returns the value <select>. */
async function addFilter(page, fieldLabel) {
  await page.getByRole('button', { name: '+ Add filter' }).click();
  const fieldSelect = page.getByRole('combobox').filter({ hasText: 'Select field...' });
  await fieldSelect.selectOption({ label: fieldLabel });
  return page.getByRole('combobox').filter({ hasText: 'Select value...' });
}

/** The number rendered next to the page title ("1,234 total"). */
async function headerTotal(page) {
  const text = await page.getByText(/^[\d,]+ total$/).first().innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

/**
 * Shared body for both list pages: the System filter is offered, lists every
 * system by display name (including ones with no rows), and narrows the table
 * to exactly the rows the API reports for that system.
 */
async function assertSystemFilterNarrows(page, request, { hash, path }) {
  const systems = await fetchSystems(request);
  test.skip(systems.length === 0, 'no systems in this deployment');

  // Ask the list endpoint itself how many rows each system contributes — the
  // /api/systems counts include rows this list hides (business roles, deleted).
  const unfilteredTotal = await apiTotal(request, path, null);
  const perSystem = [];
  for (const s of systems) {
    perSystem.push({ system: s, total: await apiTotal(request, path, s.displayName) });
  }
  // The smallest non-empty system — guarantees the filter really narrows.
  const narrowing = perSystem
    .filter(x => x.total > 0 && x.total < unfilteredTotal)
    .sort((a, b) => a.total - b.total)[0];
  test.skip(!narrowing, `needs ${path} in at least two systems (demo dataset)`);
  const target = narrowing.system;
  const filteredTotal = narrowing.total;

  await page.goto(`${BASE}/#${hash}`);
  await page.waitForSelector('table tbody tr');
  expect(await headerTotal(page)).toBe(unfilteredTotal);

  const valueSelect = await addFilter(page, 'System');

  // Every system is offered by display name — including one with no rows at
  // all, because the values come from the Systems table, not from the list.
  const offered = await valueSelect.locator('option').allTextContents();
  for (const s of systems) expect(offered).toContain(s.displayName);

  await valueSelect.selectOption(target.displayName);

  // The pill names the field and the chosen system…
  const pill = page.locator('span:has(> span:text-is("System:")) select');
  await expect(pill).toHaveValue(target.displayName);
  // …and the table now holds only that system's rows.
  await expect.poll(() => headerTotal(page)).toBe(filteredTotal);
}

test.describe('Filter by system (issue #1204)', () => {
  test('Principals page filters by System', async ({ page, request }) => {
    await assertSystemFilterNarrows(page, request, { hash: 'principals', path: 'users' });
  });

  test('Resources page filters by System', async ({ page, request }) => {
    await assertSystemFilterNarrows(page, request, { hash: 'resources', path: 'resources' });
  });
});

test.describe('One context per system (issue #1204)', () => {
  // dry-run exercises the real plugin against the real data without writing,
  // so the e2e proves the registration + output shape without leaving
  // generated contexts behind on the demo deployment.
  for (const [pluginName, rootName, countKey] of [
    ['system-membership-principals', 'Principals by system', 'principalCount'],
    ['system-membership-resources', 'Resources by system', 'resourceCount'],
  ]) {
    test(`${pluginName} emits one context per system, named after the system`, async ({ request }) => {
      const systems = await fetchSystems(request);
      test.skip(systems.length === 0, 'no systems in this deployment');
      // dry-run samples the first 10 contexts (root + one per system).
      test.skip(systems.length > 9, 'too many systems to assert on the sampled contexts');

      const res = await request.post(`${API}/context-plugins/${pluginName}/dry-run`, { data: {} });
      expect(res.ok()).toBe(true);
      const { contextCount, memberCount, samples } = await res.json();

      // One root + one child per system.
      expect(contextCount).toBe(systems.length + 1);
      const names = samples.contexts.map(c => c.displayName);
      expect(names).toContain(rootName);
      for (const s of systems) expect(names).toContain(s.displayName);

      // Members are the rows of those systems, not the systems themselves.
      const expectedMembers = systems.reduce((n, s) => n + Number(s[countKey] || 0), 0);
      expect(memberCount).toBeGreaterThan(0);
      expect(memberCount).toBeLessThanOrEqual(expectedMembers);
    });
  }
});
