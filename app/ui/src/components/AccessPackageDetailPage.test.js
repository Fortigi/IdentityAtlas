import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AccessPackageDetailPage.jsx'), 'utf8');

describe('AccessPackageDetailPage', () => {
  it('delegates the detail scaffold to EntityDetailPage', () => {
    expect(src).toContain('EntityDetailPage');
  });

  it('fetches the access package and its (optional) risk score', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/access-package/');
    expect(src).toContain('/api/risk-scores/business-roles/');
  });

  it('holds the risk data in state', () => {
    expect(src).toContain('setRiskData');
  });
});
