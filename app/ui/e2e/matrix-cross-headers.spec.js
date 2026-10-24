// @ts-check
//
// #1049 — the matrix grouping headers as a compact cross table.
//
// The header used to spend 120px per sort attribute on vertically-written
// merged labels, which on a laptop screen left less room for the grid than for
// its header. When the cross table is the shorter representation it now renders
// instead: one 20px row per distinct value, with a ✕ in every subject column
// that carries it. Everything the reporter refused to lose — folding a group by
// clicking its header, unfolding it again — keeps working, and the style must
// NOT flip while they interact with a given matrix.
//
// Both sort attributes are picked from the deployment under test at run time
// (few distinct values over the matrix subjects → cross table; many → the
// rotated fallback), so the spec holds on the demo dataset and a real tenant
// alike.

import { test, expect } from '@playwright/test';
import { API, matrixColumns, openMatrixWithFilter } from './matrixWizard.js';

const VALUE_ROW_H = 20;
const GROUP_ROW_H = 120;

// The cross table is chosen when it is no taller than the rotated row it
// replaces: at most GROUP_ROW_H / VALUE_ROW_H distinct values for one level.
const MAX_CROSS_VALUES = GROUP_ROW_H / VALUE_ROW_H;

// Columns usable as a subject sort attribute: text columns the matrix rows
// carry (displayName / email travel under different names).
const SORTABLE = (c) => c.type === 'text' && !['displayName', 'email', 'id'].includes(c.column);

// The column sort is applied client-side, so the payload is the same whichever
// attribute is named — one fetch answers for every candidate.
const filterFor = (attribute) => ({ sortAttributes: [{ attribute, dir: 'asc' }] });

// How many distinct values each candidate attribute has over the subjects this
// matrix actually renders — read from the very payload the page will use, so
// the expected header style is known exactly rather than guessed.
async function distinctPerAttribute(attributes) {
  const res = await fetch(`${API}/matrix/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { rowType: 'principal', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } }),
  });
  if (!res.ok) return null;
  const rows = (await res.json()).data || [];
  if (rows.length === 0) return null;
  const seen = new Map(attributes.map(a => [a, new Map()]));
  for (const row of rows) {
    for (const attribute of attributes) {
      const raw = attribute.startsWith('ext.')
        ? row.extendedAttributes?.[attribute.slice(4)]
        : row[attribute];
      seen.get(attribute).set(row.memberId, raw == null ? '' : String(raw));
    }
  }
  return new Map([...seen].map(([a, byMember]) => [a, new Set(byMember.values()).size]));
}

// Header rows above the pinned names row — the grouping rows this issue is about.
async function groupingRowHeights(table) {
  const rows = table.locator('thead tr');
  const count = await rows.count();
  const heights = [];
  for (let i = 0; i < count - 1; i++) {
    const box = await rows.nth(i).boundingBox();
    heights.push(box ? box.height : 0);
  }
  return heights;
}

let attributeSizes = null;
async function pickAttribute(fits) {
  if (!attributeSizes) {
    const candidates = (await matrixColumns('Principal')).filter(SORTABLE).map(c => c.column);
    attributeSizes = await distinctPerAttribute(candidates);
  }
  if (!attributeSizes) return null;
  for (const [attribute, size] of attributeSizes) if (fits(size)) return attribute;
  return null;
}

test.describe('#1049 — compact cross-table matrix headers', () => {
  test.setTimeout(120000);

  test('a low-cardinality sort attribute renders thin value rows with a mark per column', async ({ page }) => {
    const attribute = await pickAttribute(n => n >= 2 && n <= MAX_CROSS_VALUES);
    test.skip(!attribute, 'no subject attribute with 2–6 distinct values in this deployment');

    const table = await openMatrixWithFilter(page, filterFor(attribute));
    const heights = await groupingRowHeights(table);

    expect(heights.length).toBeGreaterThan(0);
    // Every grouping row is a thin value row, and the whole stack is shorter
    // than the single rotated row it replaces — the point of the issue.
    for (const h of heights) expect(h).toBeLessThanOrEqual(VALUE_ROW_H + 4);
    expect(heights.reduce((a, b) => a + b, 0)).toBeLessThan(GROUP_ROW_H);
    expect(heights.length).toBe(attributeSizes.get(attribute));

    // One mark per applicable subject column — a run spanning five columns
    // carries five marks, not one centred one.
    const header = table.locator('thead');
    await expect(header).toContainText('✕');
    const runCells = header.locator('th:has(button[aria-label$="into one column"])');
    const runCount = await runCells.count();
    expect(runCount).toBeGreaterThan(0);
    for (let i = 0; i < runCount; i++) {
      const cell = runCells.nth(i);
      const span = Number(await cell.getAttribute('colspan')) || 1;
      expect(await cell.locator('span').count()).toBe(span);
    }
  });

  test('clicking a run folds its group and clicking the folded column unfolds it — style unchanged', async ({ page }) => {
    const attribute = await pickAttribute(n => n >= 2 && n <= MAX_CROSS_VALUES);
    test.skip(!attribute, 'no subject attribute with 2–6 distinct values in this deployment');

    const table = await openMatrixWithFilter(page, filterFor(attribute));

    // Every run is a real, named control — not a bare clickable <th>.
    const runs = page.getByRole('button', { name: /into one column$/ });
    await expect(runs.first()).toBeVisible({ timeout: 30000 });
    const label = await runs.first().getAttribute('aria-label');
    const value = String(label).replace(/^Collapse /, '').replace(/ into one column$/, '');

    await runs.first().click();

    // Folded: the group is one aggregate column, marked ▤ and offering the way back.
    const unfold = page.getByRole('button', { name: `Expand ${value} back into its columns` });
    await expect(unfold).toBeVisible({ timeout: 30000 });
    await expect(table.locator('thead')).toContainText('▤');

    // The header style must NOT change as a result of interacting with the
    // matrix — still the thin cross-table rows it started as.
    for (const h of await groupingRowHeights(table)) expect(h).toBeLessThanOrEqual(VALUE_ROW_H + 4);

    await unfold.click();
    await expect(page.getByRole('button', { name: `Collapse ${value} into one column` })).toBeVisible({ timeout: 30000 });
    for (const h of await groupingRowHeights(table)) expect(h).toBeLessThanOrEqual(VALUE_ROW_H + 4);
  });

  test('a high-cardinality sort attribute keeps the original rotated header', async ({ page }) => {
    const attribute = await pickAttribute(n => n > MAX_CROSS_VALUES);
    test.skip(!attribute, 'no high-cardinality subject attribute in this deployment');

    const table = await openMatrixWithFilter(page, filterFor(attribute));
    const heights = await groupingRowHeights(table);

    // A cross table with this many values would be taller than what it
    // replaces, so the rotated row stays — one 120px row, no marks.
    expect(heights.length).toBe(1);
    expect(heights[0]).toBeGreaterThan(GROUP_ROW_H - 4);
    await expect(table.locator('thead')).not.toContainText('✕');
  });
});
