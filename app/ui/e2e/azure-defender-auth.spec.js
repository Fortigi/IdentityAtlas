// @ts-check
// E2E for #1163 — "Defender for Cloud shows the Azure deployment as unauthenticated".
//
// Microsoft Defender for Cloud's "App Service apps should have authentication
// enabled" recommendation audits the App Service *platform* auth config
// (authSettingsV2 / Easy Auth), which the Azure deployment intentionally never
// writes: Identity Atlas enforces Entra sign-in inside the application. The
// portal marker is therefore expected, and the walkthrough documents it plus
// the exemption path.
//
// What Defender cannot see — and what this spec proves — is that the
// application layer really does reject anonymous access. These are exactly the
// two "How to confirm auth really is on" checks from
// docs/architecture/azure-deployment-walkthrough.md, so replaying this suite
// against a deployed stack is the evidence that the finding is cosmetic.

import { test, expect } from '@playwright/test';

/** Auth config as an Azure deployment reports it after walkthrough Steps 1-3. */
const DEPLOYED_AUTH_CONFIG = {
  enabled: true,
  configured: true,
  tenantId: '00000000-0000-0000-0000-000000000001',
  clientId: '00000000-0000-0000-0000-000000000002',
  platform: 'azure-app-service',
};

test.describe('Azure deployment — application-level auth (Defender #1163)', () => {
  test('the API reports its own auth state, and enforces it on unauthenticated calls', async ({ request }) => {
    const res = await request.get('/api/auth-config');
    expect(res.status()).toBe(200);
    const config = await res.json();

    // Walkthrough check 2: with auth on, an API call without a token is a 401.
    // The default E2E stack runs in open mode (AUTH_ENABLED=false), so this
    // half only executes when the suite is replayed against a deployment that
    // has auth enabled — which is the environment the bug was reported from.
    if (config.enabled) {
      const anon = await request.get('/api/auth-me');
      expect(anon.status()).toBe(401);
      return;
    }

    // Open mode: assert the stack is truthfully open rather than silently
    // skipping, so a misconfigured "auth is on" run can't pass as a no-op.
    expect(config.configured).toBe(false);
    const anon = await request.get('/api/auth-me');
    expect(anon.status()).toBe(200);
    expect(await anon.json()).toMatchObject({ enabled: false });
  });

  test('with auth enabled an anonymous visitor is sent to Entra, never to the app', async ({ page }) => {
    // Present the deployed-and-configured auth state to the SPA.
    await page.route('**/api/auth-config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DEPLOYED_AUTH_CONFIG),
      })
    );
    // Stand in for Entra's sign-in page: the real one is out of scope here (and
    // the test tenant is fictional), so serve a marker page instead. The
    // assertion is that we got sent there at all.
    const authorizeUrls = [];
    await page.route('**login.microsoftonline.com/**', (route) => {
      authorizeUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Entra sign-in (stub)</h1></body></html>',
      });
    });

    await page.goto('/');

    // Walkthrough check 1: the anonymous visitor lands on Entra, not on the app.
    await expect(page.getByRole('heading', { name: 'Entra sign-in (stub)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Matrix', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0);

    // And the sign-in request is the one the deployment configured: our tenant,
    // our client, asking for the API scope the server validates the audience
    // against. This whole exchange is invisible to Defender's platform check.
    const authorize = authorizeUrls.find((u) => u.includes('/oauth2/v2.0/authorize'));
    expect(authorize).toBeTruthy();
    expect(authorize).toContain(`/${DEPLOYED_AUTH_CONFIG.tenantId}/`);
    expect(authorize).toContain(`client_id=${DEPLOYED_AUTH_CONFIG.clientId}`);
    expect(decodeURIComponent(authorize)).toContain(`api://${DEPLOYED_AUTH_CONFIG.clientId}/access`);
  });
});
