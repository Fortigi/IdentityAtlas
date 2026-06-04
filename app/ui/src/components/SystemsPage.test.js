import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'SystemsPage.jsx'), 'utf8');

describe('Systems page onboarding', () => {
  it('no longer instructs users to run the stale Start-FGSync CLI command', () => {
    expect(src).not.toContain('Start-FGSync');
  });

  it('points users to the supported "Add a crawler" path instead', () => {
    expect(src).toContain('Add a crawler');
    expect(src).toContain('EmptyState');
  });
});
