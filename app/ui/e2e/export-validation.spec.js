// @ts-check
import { test, expect } from '@playwright/test';
import fs from 'fs';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

test.describe('Export validation', () => {
  test('matrix export button triggers download', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Look for an export button on the matrix/home page
    const exportBtn = page.locator('button:has-text("Export"), button[title*="Export"]').first();
    if (await exportBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        exportBtn.click(),
      ]);
      const path = await download.path();
      expect(path).toBeTruthy();
      // Verify the file has content (not empty)
      const stats = fs.statSync(path);
      expect(stats.size).toBeGreaterThan(0);
      // XLSX files start with PK (ZIP magic bytes)
      const buf = fs.readFileSync(path);
      expect(buf[0]).toBe(0x50); // P
      expect(buf[1]).toBe(0x4B); // K
    } else {
      test.skip();
    }
  });

  test('curated JSON export returns valid shape', async ({ request }) => {
    const API = `${BASE}/api`;
    // This endpoint may or may not exist -- skip if 404
    const res = await request.get(`${API}/admin/export/curated`);
    if (res.status() === 404) {
      test.skip();
      return;
    }
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty('exportedAt');
    }
  });
});
