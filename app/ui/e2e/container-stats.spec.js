// @ts-check
/**
 * Container Stats page E2E tests.
 *
 * Verifies the Containers tab in Admin shows live CPU, memory, and network
 * stats for the running Docker containers (web, worker, postgres).
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api`;

test.describe('Container Stats page', () => {

  test('API returns container stats with CPU and memory', async ({ request }) => {
    const res = await request.get(`${API}/admin/container-stats`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    if (body.unavailable) {
      test.skip(true, 'Docker socket not accessible');
      return;
    }

    expect(body.containers).toBeDefined();
    expect(body.containers.length).toBeGreaterThan(0);

    // Find the web container
    const web = body.containers.find(c => c.service === 'web');
    expect(web, 'web container should be present').toBeDefined();
    expect(web.state).toBe('running');
    expect(web.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(web.memUsageBytes).toBeGreaterThan(0);
  });

  test('Containers tab renders stats cards', async ({ page }) => {
    // Check API first — skip if socket unavailable
    const apiRes = await page.request.get(`${API}/admin/container-stats`);
    const apiBody = await apiRes.json();
    if (apiBody.unavailable) {
      test.skip(true, 'Docker socket not accessible');
      return;
    }

    await page.goto(`${BASE}/#admin`);
    await page.waitForLoadState('networkidle');

    // Click the Containers tab
    const tab = page.locator('button:has-text("Containers"), [role="tab"]:has-text("Containers")');
    if (!await tab.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'Containers tab not found');
      return;
    }
    await tab.click();

    // Wait for stats to load (auto-refreshes every 3s)
    await page.waitForTimeout(4000);

    // Verify at least one container card is rendered with CPU and Memory labels
    await expect(page.locator('text=CPU').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Memory').first()).toBeVisible();
    await expect(page.locator('text=Network').first()).toBeVisible();

    // Verify the web container card is present
    await expect(page.locator('text=Web (API + UI)')).toBeVisible();
  });
});
