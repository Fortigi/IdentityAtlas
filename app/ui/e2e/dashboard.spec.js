// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#dashboard');
    await page.waitForLoadState('networkidle');
  });

  test('Overview tab renders the brain graph + stats', async ({ page }) => {
    // Tab strip should be visible
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trends',   exact: true })).toBeVisible();

    // Overview is the default — at least one SVG (the brain graph) must render
    const svgs = page.locator('svg');
    await expect(svgs.first()).toBeVisible();
  });

  test('Trends tab switches and renders chart container', async ({ page }) => {
    await page.getByRole('button', { name: 'Trends', exact: true }).click();

    // The headline section heading should appear
    await expect(page.getByText(/Governed assignments — % of total/i)).toBeVisible({ timeout: 10000 });

    // Range selector should be present
    const rangeSelect = page.locator('select#trends-range');
    await expect(rangeSelect).toBeVisible();
    await expect(rangeSelect).toHaveValue('90');

    // At least one chart SVG renders. The empty-state message is rendered
    // INSIDE the SVG when no snapshots exist yet, so the SVG itself is the
    // load-bearing assertion (not the line/path).
    const svgs = page.locator('svg');
    expect(await svgs.count()).toBeGreaterThan(1);
  });

  test('Trends range selector changes the days param', async ({ page }) => {
    await page.getByRole('button', { name: 'Trends', exact: true }).click();
    await expect(page.locator('select#trends-range')).toBeVisible();

    // Pick a different range — the chart should re-render (no crash).
    await page.locator('select#trends-range').selectOption('30');
    await expect(page.locator('select#trends-range')).toHaveValue('30');
    // Still on the Trends tab afterwards
    await expect(page.getByText(/Governed assignments — % of total/i)).toBeVisible();
  });
});
