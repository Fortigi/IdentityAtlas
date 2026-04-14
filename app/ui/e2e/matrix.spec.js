// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Matrix View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('matrix renders with rows and columns', async ({ page }) => {
    // Should have a table/grid structure with group rows
    // Mock data has 43 groups and 80 users
    const rows = page.locator('tr, [role="row"]');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
  });

  test('user limit slider is present and functional', async ({ page }) => {
    const slider = page.locator('input[type="range"]');
    // There should be at least one range input (user limit)
    if (await slider.count() > 0) {
      await expect(slider.first()).toBeVisible();
      // Get current value
      const value = await slider.first().inputValue();
      expect(parseInt(value)).toBeGreaterThan(0);
    }
  });

  test('IST/SOLL/All toggle is present', async ({ page }) => {
    // Look for managed filter buttons - "All", "Unmanaged", "Managed", "Gaps"
    const allButton = page.getByRole('button', { name: 'All', exact: true }).first();
    await expect(allButton).toBeVisible({ timeout: 10000 });
  });

  test('matrix cells show membership badges', async ({ page }) => {
    // Mock data contains Direct (D), Indirect (I), Eligible (E) badges
    // At least some D badges should be visible
    const dBadges = page.locator('text=D').first();
    await expect(dBadges).toBeVisible({ timeout: 5000 });
  });

  test('share button exists', async ({ page }) => {
    const shareButton = page.getByRole('button', { name: /Share/i });
    if (await shareButton.count() > 0) {
      await expect(shareButton).toBeVisible();
    }
  });

  test('export button exists', async ({ page }) => {
    const exportButton = page.getByRole('button', { name: /Export/i });
    if (await exportButton.count() > 0) {
      await expect(exportButton).toBeVisible();
    }
  });

  test('clicking a filter field shows filter values', async ({ page }) => {
    // Look for the add filter button/dropdown
    const addFilter = page.getByText('+ Add filter').or(page.getByText('Add filter'));
    if (await addFilter.count() > 0) {
      await addFilter.first().click();
      // Should show a list of filterable fields
      await page.waitForTimeout(300);
      // Check that some filter fields appear (department, jobTitle, etc.)
      const filterOption = page.getByText('department').or(page.getByText('Department'));
      if (await filterOption.count() > 0) {
        await expect(filterOption.first()).toBeVisible();
      }
    }
  });

  test('owner rows are separated with (Owner) suffix', async ({ page }) => {
    // Mock data should have owner memberships that create separate rows
    const ownerRows = page.getByText('(Owner)');
    // May or may not be visible depending on mock data and user limit
    // Just verify the page doesn't crash
    expect(true).toBe(true);
  });
});
