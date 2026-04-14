// @ts-check
/**
 * Custom Connector wizard E2E tests.
 *
 * Verifies the 3-step wizard flow: select type → register → API key → getting started.
 * Runs against the Docker backend (real API) when E2E_BASE_URL is set.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

test.describe('Custom Connector wizard', () => {

  test('Custom Connector type is selectable', async ({ page }) => {
    await page.goto(`${BASE}/#admin`);
    await page.waitForLoadState('networkidle');

    // Click "Add Crawler" button
    const addBtn = page.locator('button:has-text("Add Crawler")');
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip();
      return;
    }
    await addBtn.click();

    // The type selection grid should show Custom Connector as enabled
    const customBtn = page.locator('button:has-text("Custom Connector")');
    await expect(customBtn).toBeVisible();
    await expect(customBtn).toBeEnabled();

    // Should NOT have "Coming soon" badge
    const badge = page.locator('text=Coming soon');
    await expect(badge).not.toBeVisible();
  });

  test('wizard registers connector and shows API key', async ({ page }) => {
    await page.goto(`${BASE}/#admin`);
    await page.waitForLoadState('networkidle');

    const addBtn = page.locator('button:has-text("Add Crawler")');
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip();
      return;
    }
    await addBtn.click();

    // Select Custom Connector
    const customBtn = page.locator('button:has-text("Custom Connector")');
    await expect(customBtn).toBeVisible({ timeout: 5000 });
    await customBtn.click();

    // Step 1: Fill in name and register
    await expect(page.locator('h3:has-text("Custom Connector")')).toBeVisible({ timeout: 10000 });
    await page.fill('input[placeholder*="SAP"]', 'E2E-Test-Connector');
    await page.click('button:has-text("Register Connector")');

    // Step 2: API key should be displayed
    await expect(page.locator('text=Save this API key now')).toBeVisible({ timeout: 10000 });
    // The key starts with fgc_
    const keyEl = page.locator('code').filter({ hasText: 'fgc_' });
    await expect(keyEl).toBeVisible();

    // Click Next
    await page.click('button:has-text("Next: Getting Started")');

    // Step 3: Getting Started page
    await expect(page.locator('text=Swagger UI')).toBeVisible();
    await expect(page.locator('text=Download OpenAPI Spec')).toBeVisible();
    await expect(page.locator('text=CSV Schema Reference')).toBeVisible();

    // Code examples tabs should be present
    await expect(page.locator('button:has-text("curl")')).toBeVisible();
    await expect(page.locator('button:has-text("Python")')).toBeVisible();
    await expect(page.locator('button:has-text("PowerShell")')).toBeVisible();

    // Done button should work
    await page.click('button:has-text("Done")');
    // Wizard should close
    await expect(page.locator('h3:has-text("Custom Connector")')).not.toBeVisible();
  });

  test('OpenAPI spec is downloadable', async ({ request }) => {
    const res = await request.get(`${BASE}/api/openapi.json`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.openapi).toBeDefined();
    expect(body.paths['/ingest/systems']).toBeDefined();
    expect(body.paths['/ingest/principals']).toBeDefined();
    expect(body.paths['/ingest/resources']).toBeDefined();
  });
});
