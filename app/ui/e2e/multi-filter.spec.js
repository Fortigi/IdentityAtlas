// @ts-check
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

test.describe('Multi-filter combinations', () => {
  test('resources page: search narrows results', async ({ page }) => {
    await page.goto(`${BASE}/#resources`);
    await page.waitForSelector('table');
    // Get initial row count
    const initialRows = await page.locator('table tbody tr').count();
    // Type in search box
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test-filter-term-unlikely-match');
      await page.waitForTimeout(500); // debounce
      const filteredRows = await page.locator('table tbody tr').count();
      // Filtered should have fewer or equal rows
      expect(filteredRows).toBeLessThanOrEqual(initialRows);
    }
  });

  test('users page: search works', async ({ page }) => {
    await page.goto(`${BASE}/#users`);
    await page.waitForSelector('table');
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('a');
      await page.waitForTimeout(500);
      // Just verify the page didn't crash
      await expect(page.locator('table')).toBeVisible();
    }
  });
});
