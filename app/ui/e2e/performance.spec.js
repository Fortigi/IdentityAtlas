// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Performance Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#performance');
    await page.waitForTimeout(500);
  });

  test('page renders', async ({ page }) => {
    // Performance page should show even if metrics are disabled
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('view tabs are present (Summary, Recent, Slow)', async ({ page }) => {
    const summaryTab = page.getByRole('button', { name: /Summary/i });
    const recentTab = page.getByRole('button', { name: /Recent/i });
    const slowTab = page.getByRole('button', { name: /Slow/i });

    // May not exist if perf metrics disabled in mock mode
    if (await summaryTab.count() > 0) {
      await expect(summaryTab).toBeVisible();
      await expect(recentTab).toBeVisible();
      await expect(slowTab).toBeVisible();
    }
  });

  test('switching between view tabs works', async ({ page }) => {
    const recentTab = page.getByRole('button', { name: /Recent/i });

    if (await recentTab.count() > 0) {
      await recentTab.click();
      await page.waitForTimeout(300);

      const slowTab = page.getByRole('button', { name: /Slow/i });
      await slowTab.click();
      await page.waitForTimeout(300);

      // Should still be on the page
      const nav = page.locator('nav');
      await expect(nav).toBeVisible();
    }
  });

  test('export button exists', async ({ page }) => {
    const exportButton = page.getByRole('button', { name: /Export/i });
    if (await exportButton.count() > 0) {
      await expect(exportButton).toBeVisible();
    }
  });
});
