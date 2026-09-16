// @ts-check
/**
 * Issue #872 — tenant-specific prefixes must not reach the GUI.
 *
 * Entra directory-extension attributes arrive from Graph under their wire name,
 * `extension_<32-hex appId>_<attributeName>`. That prefix means nothing to an
 * analyst and, at ~50 characters, crowds every label out of its column. The
 * feature shows the readable tail — `sAMAccountName` — everywhere a name is
 * rendered, while the STORED KEY stays byte-identical so filters and sorts keep
 * addressing the real JSON key.
 *
 * Both halves of that sentence are what this spec checks, because only showing
 * the clean name is easy to get right by breaking the other half: a fix that
 * renamed the key would look identical on screen and silently stop filtering.
 * So every assertion below pairs "the name shown is stripped" with "the value
 * sent is still the full key".
 *
 * The demo dataset carries one such attribute on its Entra principals
 * (test/demo-dataset/parts/DemoOrg.ps1), which is what makes this runnable
 * against any deployment loaded with demo data. A deployment with no extension
 * attribute at all has nothing to assert, so the suite skips rather than
 * passing vacuously.
 */

import { test, expect } from '@playwright/test';
import { openAttributePicker, API } from './matrixWizard.js';

// The wire-name shape, anchored and exactly 32 hex characters — the same rule
// the server applies. `extension_nothex_foo` is NOT an extension key.
const EXTENSION_KEY_RE = /^extension_([0-9a-f]{32})_(.+)$/i;

/**
 * One relabelled principal attribute from the deployment under test, as
 * `{ key, label }`, or null when it holds none.
 */
async function extensionAttribute(request) {
  const res = await request.get(`${API}/attribute-labels?target=principal`);
  if (!res.ok()) return null;
  const labels = (await res.json()).labels || {};
  const key = Object.keys(labels).find(k => EXTENSION_KEY_RE.test(k));
  return key ? { key, label: labels[key] } : null;
}

test.describe('Entra extension-attribute names (issue #872)', () => {
  test('the label endpoint strips the prefix and keeps the storage key', async ({ request }) => {
    const attr = await extensionAttribute(request);
    test.skip(!attr, 'no directory-extension attribute in this deployment');

    // The label is the tail VERBATIM — `sAMAccountName`, not a word-split
    // "S A M Account Name", and not something with the appId still in it.
    expect(attr.label).toBe(EXTENSION_KEY_RE.exec(attr.key)[2]);
    expect(attr.label).not.toMatch(/extension_/i);
    // The map is keyed by the untouched storage key: that is what makes it
    // usable as a lookup by callers holding the raw attribute name.
    expect(attr.key).toMatch(EXTENSION_KEY_RE);
  });

  test('the principals filter menu offers the clean name and filters on the raw key', async ({ page, request }) => {
    const attr = await extensionAttribute(request);
    test.skip(!attr, 'no directory-extension attribute in this deployment');

    await page.goto('/#principals');
    await expect(page.locator('table').first()).toBeVisible({ timeout: 30000 });

    await page.getByRole('button', { name: '+ Add filter' }).first().click();
    const fieldSelect = page.locator('select').filter({ hasText: 'Select field...' }).first();
    await expect(fieldSelect).toBeVisible();

    // Shown: the stripped name. Sent: `ext.` + the full stored key.
    const option = fieldSelect.locator(`option[value="ext.${attr.key}"]`);
    await expect(option).toHaveCount(1);
    await expect(option).toHaveText(attr.label);

    // And no option anywhere in that menu still carries a wire name.
    const optionTexts = await fieldSelect.locator('option').allTextContents();
    expect(optionTexts.filter(t => /extension_[0-9a-f]{32}_/i.test(t))).toEqual([]);
  });

  test('the matrix attribute picker offers the clean name', async ({ page, request }) => {
    const attr = await extensionAttribute(request);
    test.skip(!attr, 'no directory-extension attribute in this deployment');

    const field = await openAttributePicker(page, 'subjects');
    const option = field.locator(`option[value="ext.${attr.key}"]`);
    await expect(option).toHaveCount(1);
    // The picker suffixes each field with its value count, so match the stem.
    await expect(option).toHaveText(new RegExp(`^${attr.label} \\(\\d+\\+?\\)$`));

    const optionTexts = await field.locator('option').allTextContents();
    expect(optionTexts.filter(t => /extension_[0-9a-f]{32}_/i.test(t))).toEqual([]);
  });

  test('a principal detail page names the attribute without its prefix', async ({ page, request }) => {
    const attr = await extensionAttribute(request);
    test.skip(!attr, 'no directory-extension attribute in this deployment');

    // Pick a principal that actually carries the attribute, so the row under
    // test is guaranteed to render (the table hides empty values).
    const res = await request.get(`${API}/users?limit=200`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.data ?? []);
    const holder = rows.find(r => (r.extendedAttributes || {})[attr.key]);
    test.skip(!holder, 'no principal carries the extension attribute');

    await page.goto(`/#user:${holder.id}`);

    // The Attributes table names it by the stripped label…
    const row = page.locator('tr', { has: page.getByText(attr.label, { exact: true }) }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText(String(holder.extendedAttributes[attr.key]));

    // …and the original Entra name stays readable as the cell's tooltip, so
    // nothing is hidden — only moved out of the way.
    await expect(row.locator(`[title="${attr.key}"]`)).toHaveCount(1);

    // Nowhere on the page does a raw wire name leak into the text.
    await expect(page.locator('body')).not.toContainText(attr.key);
  });
});
