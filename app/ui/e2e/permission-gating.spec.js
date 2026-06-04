// @ts-check
// UI permission-gating E2E.
//
// The E2E stack runs the API in open mode (AUTH_ENABLED=false), so we simulate
// a signed-in user with a specific permission set by intercepting /api/auth-me
// (the endpoint AuthGateProvider reads to populate `permissions`/`hasWildcard`).
// This exercises the real UI gating (useHasPermission / useCanSeeAdminTab /
// AdminPage sub-tab filtering) without needing an Entra sign-in.
//
// The server-side enforcement of each permission is covered exhaustively in
// app/api/src/auth/permissionMatrix.test.js; this is the complementary check
// that the UI hides what the user can't use.

import { test, expect } from '@playwright/test';

/** Stub /api/auth-me so the SPA thinks it's signed in with these permissions. */
async function signInAs(page, { permissions = [], hasWildcard = false } = {}) {
  await page.route('**/api/auth-me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, roles: ['e2e-role'], permissions, hasWildcard }),
    })
  );
}

const adminTab = (page) => page.getByRole('button', { name: 'Admin', exact: true });
const tabBtn = (page, label) => page.getByRole('button', { name: label, exact: true });

test.describe('UI permission gating', () => {
  test('read-only user (data.read) does not see the Admin tab', async ({ page }) => {
    await signInAs(page, { permissions: ['data.read'], hasWildcard: false });
    await page.goto('/');
    // App loaded (a non-admin tab is present)…
    await expect(tabBtn(page, 'Matrix')).toBeVisible();
    // …but no Admin tab (auto-retries until /auth-me flips the open-mode default).
    await expect(adminTab(page)).toHaveCount(0);
  });

  test('wildcard user sees the Admin tab with crawler + auth sub-tabs', async ({ page }) => {
    await signInAs(page, { permissions: [], hasWildcard: true });
    await page.goto('/');
    await expect(adminTab(page)).toBeVisible();
    await adminTab(page).click();
    await expect(tabBtn(page, 'Crawlers')).toBeVisible();
    await expect(tabBtn(page, 'Authentication')).toBeVisible();
  });

  // Each admin permission should reveal the Admin tab AND only its own sub-tab(s).
  const cases = [
    { perm: 'admin.crawlers', shows: 'Crawlers', hides: ['Authentication', 'LLM Settings'] },
    { perm: 'admin.auth', shows: 'Authentication', hides: ['Crawlers', 'LLM Settings'] },
    { perm: 'admin.llm', shows: 'LLM Settings', hides: ['Crawlers', 'Authentication'] },
  ];

  for (const c of cases) {
    test(`${c.perm}: Admin tab visible, only its sub-tab shown`, async ({ page }) => {
      await signInAs(page, { permissions: [c.perm], hasWildcard: false });
      await page.goto('/');
      await expect(adminTab(page)).toBeVisible();
      await adminTab(page).click();
      // Wait for the owned sub-tab to render before asserting the others are absent.
      await expect(tabBtn(page, c.shows)).toBeVisible();
      for (const hidden of c.hides) {
        await expect(tabBtn(page, hidden)).toHaveCount(0);
      }
    });
  }
});
