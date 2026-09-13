// @ts-check
//
// Linked Accounts table on the Identity detail page → Relationships tab.
// Proves, against the deployed app and its data, that each linked account is
// shown with the source system it came from and whether it is enabled —
// issue #1125. Dataset-independent: the identity under test and the values
// expected in its cells are both read from the live API.

import { test, expect } from '@playwright/test';
import { API } from './matrixWizard.js';

// The identity with the most linked accounts, plus its members, or null when
// the deployment has no correlated identities to look at.
async function richestIdentity() {
  const list = await fetch(`${API}/identities?sort=accountCount&dir=desc&limit=1`);
  if (!list.ok) return null;
  const id = (await list.json())?.data?.[0]?.id;
  if (!id) return null;

  const detail = await fetch(`${API}/identities/${id}`);
  if (!detail.ok) return null;
  const body = await detail.json();
  return body?.members?.length ? { id, members: body.members } : null;
}

// What the UI must render in the Enabled cell for a member: live Principal
// state first, link-time snapshot as the fallback.
function expectedEnabled(member) {
  const enabled = member.userAccountEnabled ?? member.accountEnabled ?? null;
  return enabled == null ? '—' : enabled ? 'Yes' : 'No';
}

async function openLinkedAccounts(page, identityId) {
  await page.goto(`/#identity:${identityId}`);
  await page.getByRole('tab', { name: /Relationships/i }).click();
  const panel = page.locator('div:has(> h3:text-is("Linked Accounts"))');
  await expect(panel.getByRole('table')).toBeVisible({ timeout: 10000 });
  return panel;
}

test.describe('Linked Accounts — System and Enabled columns', () => {
  test('table header reads System | Account | Enabled | Type', async ({ page }) => {
    const identity = await richestIdentity();
    if (!identity) { test.skip(true, 'No correlated identities in this deployment'); return; }

    const panel = await openLinkedAccounts(page, identity.id);
    const headers = panel.getByRole('columnheader');
    await expect(headers).toHaveCount(5); // 4 labelled + the actions column
    await expect(headers.nth(0)).toHaveText('System');
    await expect(headers.nth(1)).toHaveText('Account');
    await expect(headers.nth(2)).toHaveText('Enabled');
    await expect(headers.nth(3)).toHaveText('Type');
  });

  test('every account row shows its own source system and enabled state', async ({ page }) => {
    const identity = await richestIdentity();
    if (!identity) { test.skip(true, 'No correlated identities in this deployment'); return; }

    const panel = await openLinkedAccounts(page, identity.id);
    const rows = panel.locator('tbody tr');
    await expect(rows).toHaveCount(identity.members.length);

    for (const member of identity.members) {
      const row = rows.filter({ has: page.getByRole('button', { name: member.displayName, exact: true }) }).first();
      const cells = row.locator('td');
      await expect(cells.nth(0)).toHaveText(member.systemDisplayName || '—');
      await expect(cells.nth(2)).toHaveText(expectedEnabled(member));
      await expect(cells.nth(3)).toHaveText(member.accountType || '—');
    }
  });

  test('the account name still opens the account detail, and link actions survive', async ({ page }) => {
    const identity = await richestIdentity();
    if (!identity) { test.skip(true, 'No correlated identities in this deployment'); return; }

    const panel = await openLinkedAccounts(page, identity.id);
    // Every row keeps its actions: either the link-management buttons or the
    // "Linked from source" note for crawler-owned links.
    for (const member of identity.members) {
      const row = panel.locator('tbody tr')
        .filter({ has: page.getByRole('button', { name: member.displayName, exact: true }) }).first();
      const actions = row.locator('td').nth(4);
      await expect(actions).not.toBeEmpty();
    }

    const first = identity.members[0];
    await panel.getByRole('button', { name: first.displayName, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`#user:${first.principalId}`));
  });
});
