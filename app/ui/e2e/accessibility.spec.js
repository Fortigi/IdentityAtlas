// @ts-check
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

const pages = [
  { name: 'Home', hash: '' },
  { name: 'Users', hash: '#users' },
  { name: 'Resources', hash: '#resources' },
  { name: 'Systems', hash: '#systems' },
  { name: 'Sync Log', hash: '#sync-log' },
];

for (const p of pages) {
  test(`${p.name} page has no critical accessibility violations`, async ({ page }) => {
    await page.goto(`${BASE}/${p.hash}`);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    // Only fail on critical/serious, not minor
    const serious = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    expect(serious, `A11y violations on ${p.name}: ${serious.map(v => v.id).join(', ')}`).toHaveLength(0);
  });
}
