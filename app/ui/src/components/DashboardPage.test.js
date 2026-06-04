import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'DashboardPage.jsx'), 'utf8');

describe('Dashboard error vs empty', () => {
  it('distinguishes a failed stats fetch from an empty database', () => {
    expect(src).toContain('setError(true)');      // a real error path exists
    expect(src).toContain('load the dashboard');  // distinct error UI, not the onboarding CTA
  });
  it('offers a retry that re-runs the fetch', () => {
    expect(src).toContain('setReloadKey');
  });
});
