// @ts-check
//
// Shared setup for the matrix-wizard e2e specs.
//
// Every wizard spec opens the same way: read a value out of the deployment
// under test (so the spec is dataset-independent and runs against the demo
// dataset or a real tenant alike), then drive Matrix → Adjust matrix → Next…
// → "+ Attribute" to reach the attribute picker. Keeping that here means a
// change to the wizard's chrome is a one-line edit instead of a sweep across
// every spec that reaches the picker.
//
// Not a `*.spec.js`, so Playwright's testMatch never collects it as a suite.

import { expect } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
export const API = `${BASE}/api`;

// "Next" clicks needed to reach a wizard step from the opening Setup step.
const STEP_CLICKS = { subjects: 1, resources: 2 };

// The entity whose column metadata backs each step's Include list.
const STEP_ENTITY = { subjects: 'Principal', resources: 'Resource' };

/**
 * One stored value of a resource column, read from the deployment under test:
 * `dir: 'asc'` yields the alphabetically first, `'desc'` the alphabetically
 * last. Returns null when no resource carries a usable value for that column.
 *
 * @param {string} column
 * @param {'asc' | 'desc'} dir
 * @returns {Promise<string | null>}
 */
export async function resourceValue(column, dir) {
  const res = await fetch(`${API}/resources?sort=${column}&dir=${dir}&limit=1`);
  if (!res.ok) return null;
  const body = await res.json();
  const value = body?.data?.[0]?.[column];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The named entry of /matrix/columns, or null when the deployment has no such
 * column.
 *
 * @param {string} column
 * @param {string} [entity]
 */
export async function matrixColumn(column, entity = 'Resource') {
  const res = await fetch(`${API}/matrix/columns?entity=${entity}`);
  if (!res.ok) return null;
  return (await res.json()).find(c => c.column === column) || null;
}

/**
 * Open the matrix wizard's "Add attribute filter" picker on the given step and
 * return its Field dropdown, fully populated.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'subjects' | 'resources'} step
 */
export async function openAttributePicker(page, step) {
  await page.goto(`${BASE}/#matrix`);
  await page.waitForLoadState('networkidle');

  // Open the wizard — "Create matrix" on the empty state, "Adjust matrix"
  // once a matrix is loaded.
  const openWizard = page.getByRole('button', { name: /Create matrix|Adjust matrix/ }).first();
  await expect(openWizard).toBeVisible({ timeout: 60000 });

  // The wizard fills its field list TWICE: a fast `?schema=true` response with
  // the core columns, then the full one carrying each column's values and the
  // ext.* extension attributes derived from them. In between, the picker opens
  // fully rendered and quietly incomplete — every count reads "(0)" and no
  // extension attribute is listed at all. Nothing on screen distinguishes that
  // from a deployment that genuinely has neither, so a spec that opens the
  // picker and reads the list straight away is a coin flip: measured 4 failures
  // in 10 runs before this wait, and the same gap is what made the value
  // checkboxes in matrix-displayname-filter.spec.js intermittent.
  //
  // Armed before the click that mounts the wizard, so the response cannot land
  // before we are listening for it.
  const fullColumns = page.waitForResponse(res => {
    const url = new URL(res.url());
    return url.pathname.endsWith('/api/matrix/columns')
      && url.searchParams.get('entity') === STEP_ENTITY[step]
      && !url.searchParams.has('schema');
  }, { timeout: 60000 });

  await openWizard.click();

  // Setup → Subjects → Resources (the reporter's "Next, Next").
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toBeVisible({ timeout: 30000 });
  for (let i = 0; i < STEP_CLICKS[step]; i++) await next.click();

  await fullColumns;

  // + Attribute on that step's Include list.
  await page.getByRole('button', { name: '+ Attribute' }).first().click();
  await expect(page.getByText('Add attribute filter')).toBeVisible();

  return page.getByLabel('Field');
}
