import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AccessPackagesPage.jsx'), 'utf8');

describe('AccessPackagesPage', () => {
  it('has a loading state', () => {
    // loading is reducer-backed (set-state-in-effect cleanup, #417).
    expect(src).toContain('const [loading, setLoading] = useReducer((_, v) => v, true);');
    expect(src).toContain('Loading business roles...');
  });

  it('handles the empty / filtered-to-empty case', () => {
    expect(src).toContain('packages.length === 0');
    expect(src).toContain('No business roles match the current filters.');
  });

  it('fetches business roles through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    expect(src).toContain('/api/access-packages');
  });

  it('supports search and a type filter', () => {
    expect(src).toContain('setSearch');
    expect(src).toContain('setTypeFilter');
  });
});
