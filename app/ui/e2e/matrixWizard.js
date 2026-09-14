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
 * Open the matrix wizard on its first step.
 *
 * `beforeOpen`, when given, runs just before the click that mounts the wizard
 * — the place to arm a waitForResponse for something the wizard fetches on
 * mount — and its return value is handed back as `armed`, wrapped in an object
 * so an async function does not unwrap (and so await) a returned promise.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ beforeOpen?: () => any }} [options]
 */
export async function openWizard(page, { beforeOpen } = {}) {
  await page.goto(`${BASE}/#matrix`);
  await page.waitForLoadState('networkidle');

  // "New matrix" on the "Open a matrix" empty state, "Adjust matrix" (the
  // strip's Adjust button) once a matrix is loaded (#1202).
  const open = page.getByRole('button', { name: /^(New matrix|Adjust matrix)$/ }).first();
  await expect(open).toBeVisible({ timeout: 60000 });
  const armed = beforeOpen?.();
  await open.click();
  await expect(page.getByRole('button', { name: 'Next' })).toBeVisible({ timeout: 30000 });
  return { armed };
}

/**
 * Jump straight to a named wizard step via the step indicator, rather than
 * counting "Next" clicks — the step list is dynamic (a roll-up inserts Content
 * and drops Sort; Share needs a permission), so a count is only right for one
 * configuration.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 */
export async function gotoWizardStep(page, label) {
  const step = page.getByRole('button', { name: new RegExp(`Go to step \\d+: ${label}$`) });
  await expect(step).toBeVisible({ timeout: 30000 });
  await step.click();
}

/**
 * Open the matrix wizard's "Add attribute filter" picker on the given step and
 * return its Field dropdown, fully populated.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'subjects' | 'resources'} step
 */
export async function openAttributePicker(page, step) {
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
  const { armed: fullColumns } = await openWizard(page, {
    beforeOpen: () => page.waitForResponse(res => {
      const url = new URL(res.url());
      return url.pathname.endsWith('/api/matrix/columns')
        && url.searchParams.get('entity') === STEP_ENTITY[step]
        && !url.searchParams.has('schema');
    }, { timeout: 60000 }),
  });

  // Setup → Subjects → Resources (the reporter's "Next, Next").
  const next = page.getByRole('button', { name: 'Next' });
  for (let i = 0; i < STEP_CLICKS[step]; i++) await next.click();

  await fullColumns;

  // + Attribute on that step's Include list.
  await page.getByRole('button', { name: '+ Attribute' }).first().click();
  await expect(page.getByText('Add attribute filter')).toBeVisible();

  return page.getByLabel('Field');
}
