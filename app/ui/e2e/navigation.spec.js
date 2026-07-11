// @ts-check
import { test, expect } from '@playwright/test';

test.describe('App Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('app loads with title and header', async ({ page }) => {
    await expect(page).toHaveTitle(/Identity Atlas/i);
    await expect(page.locator('h1')).toContainText('Identity Atlas');
  });

  test('default page is Matrix', async ({ page }) => {
    // Matrix tab should be active by default
    // `exact: true` — without it, the wizard's "Create matrix" button on
    // the empty-state landing also matches and trips strict-mode.
    const matrixTab = page.getByRole('button', { name: 'Matrix', exact: true });
    await expect(matrixTab).toBeVisible();
  });

  test('all always-visible tabs are present', async ({ page }) => {
    // Optional tabs (Risk Scores, Identities, Org Chart, Performance, Admin) are hidden by default
    const tabs = ['Matrix', 'Principals (Users)', 'Resources', 'Systems', 'Business Roles', 'Logs'];

    for (const tab of tabs) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
  });

  test('clicking tabs changes the page', async ({ page }) => {
    // Navigate to Principals
    await page.getByRole('button', { name: 'Principals (Users)', exact: true }).click();
    await expect(page.locator('h2')).toContainText('Principals');

    // Navigate to Resources (formerly Groups)
    await page.getByRole('button', { name: 'Resources', exact: true }).click();
    await expect(page.locator('h2')).toContainText('Resources');

    // Navigate to Logs (formerly Sync Log)
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.locator('h2')).toContainText('Logs');
  });

  test('hash-based routing works', async ({ page }) => {
    // Navigate via hash
    await page.goto('/#principals');
    await expect(page.locator('h2')).toContainText('Principals');

    await page.goto('/#resources');
    await expect(page.locator('h2')).toContainText('Resources');

    await page.goto('/#sync-log');
    await expect(page.locator('h2')).toContainText('Logs');

    // Matrix is the default / fallback route
    await page.goto('/');
    await page.waitForTimeout(300);
    await expect(page.locator('nav')).toBeVisible();
  });

  test('no auth gate shown when AUTH_ENABLED=false', async ({ page }) => {
    // Should not show any login prompt
    await expect(page.getByText('Sign in')).not.toBeVisible();
    // Content should be immediately available
    await expect(page.locator('nav')).toBeVisible();
  });
});
