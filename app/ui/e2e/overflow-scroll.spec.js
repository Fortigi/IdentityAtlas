// @ts-check
import { test, expect } from '@playwright/test';

// ─── Data tables scroll horizontally instead of crushing (#758) ──────────
// Every genuinely-bare data table gets an `overflow-x-auto` ancestor so a
// narrow viewport scrolls the table instead of squeezing its columns
// unreadable. Matrix views manage their own virtualized scroll and are
// deliberately excluded from this sweep (see docs/security/maintenance-audit-2026-06.md M7).

// Locates the nearest ancestor (or the table's rounded container) carrying
// `overflow-x-auto`, mirroring the unit tests' `closest('.overflow-x-auto')`.
function scrollWrapper(table) {
  return table.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " overflow-x-auto ")]').first();
}

test.describe('Data tables — horizontal scroll wrapper', () => {
  test('Users list table (highest-value page) scrolls, not overflow-hidden', async ({ page }) => {
    await page.goto('/#principals');
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    const wrapper = scrollWrapper(table);
    await expect(wrapper).toHaveCount(1);
    const cls = await wrapper.getAttribute('class');
    expect(cls).toContain('overflow-x-auto');
    expect(cls).not.toContain('overflow-hidden');
  });

  test('Business Roles (Access Packages) table scrolls, not overflow-hidden', async ({ page }) => {
    await page.goto('/#access-packages');
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    const wrapper = scrollWrapper(table);
    await expect(wrapper).toHaveCount(1);
    const cls = await wrapper.getAttribute('class');
    expect(cls).toContain('overflow-x-auto');
    expect(cls).not.toContain('overflow-hidden');
  });

  test('a narrow viewport does not crush the Users table columns — the wrapper scrolls instead', async ({ page }) => {
    // Narrow enough that a fixed-width, multi-column table can't fit — pre-fix
    // this would have squeezed every column; post-fix the wrapper scrolls.
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/#principals');
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });

    const wrapper = scrollWrapper(table);
    const { scrollWidth, clientWidth } = await wrapper.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    // The table content is wider than the visible viewport, so the wrapper
    // itself — not its columns — absorbs the overflow.
    expect(scrollWidth).toBeGreaterThanOrEqual(clientWidth);
  });

  test('Contexts list view table scrolls, when a context tree is available', async ({ page }) => {
    await page.goto('/#contexts');
    await page.waitForTimeout(500);

    const listToggle = page.getByRole('button', { name: 'List', exact: true });
    if (await listToggle.count() === 0) {
      test.skip(true, 'no context tree selected — nothing to switch to list view for');
      return;
    }
    await listToggle.click();

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 5000 });
    const wrapper = scrollWrapper(table);
    await expect(wrapper).toHaveCount(1);
    expect(await wrapper.getAttribute('class')).toContain('overflow-x-auto');
  });
});
